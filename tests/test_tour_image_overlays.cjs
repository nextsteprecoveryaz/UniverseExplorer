const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function harness(){
  const nodes=new Map(),pending=[],layers=[],camera=[],visits=[],removed=[],messages=[];
  let active=false;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,checked:false});return nodes.get(id);};
  const sky={
    setOverlayImageLayer(layer,key){layer.layer=key;},
    removeImageLayer(key){removed.push(key);},
    gotoRaDec(ra,dec){camera.push(['position',ra,dec]);},
    setFoV(fov){camera.push(['fov',fov]);}
  };
  const c=vm.createContext({$,console,Number,Math,Date,Promise,Error,JSON,Set,
    state:{sky},atlasUI:{enabled:false},travelFrame:0,cancelAnimationFrame(){},
    tourSurveyActive:()=>active,toast:(...args)=>messages.push(args),
    showPage(){},atlasMessage(){},coordinates(){},fmt:n=>String(n),
    flyTo:o=>visits.push(o),
    jsonPost:(url,body)=>new Promise(resolve=>pending.push({url,body,resolve})),
    A:{image(url,options){
      const layer={url,options,opacity:options.opacity,setOpacity(value){this.opacity=value;}};
      layers.push(layer);return layer;
    }}
  });
  for(const file of ['journeys.js','research.js','sdss.js']){
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../static',file),'utf8'),c);
  }
  c.recordObservation=o=>visits.push(o);
  vm.runInContext('visitObservation=recordObservation',c);
  c.observation={obs_id:'original-observation',dataURL:'https://example.test/original.fits'};
  c.mosaic={url:'/mosaic.fits',ra:42,dec:13,fov:.1,min_cut:0,max_cut:50,finite_fraction:.8,sources:[{observation:{mission:'Hubble',filter:'F606W'}}]};
  c.measuredMap={url:'/measured-map.png',wcs:{CTYPE1:'RA---TAN'},ra:42,dec:13,width:34,pixel_scale_arcsec:.5,plateifu:'8485-1901',label:'Measured velocity',processing:'Original measurements'};
  vm.runInContext('sdssUI.map=measuredMap',c);
  return {$,c,pending,layers,camera,visits,removed,messages,
    active(value){active=value;},run:s=>vm.runInContext(s,c)};
}

test('an open tour blocks all three individual image projection paths',async()=>{
  const h=harness();h.active(true);
  await h.run('projectObservation(observation)');
  h.run('showResearchMosaic(mosaic);sdssOverlay()');
  assert.equal(h.pending.length,0);assert.equal(h.layers.length,0);
  assert.equal(h.camera.length,0);assert.equal(h.visits.length,0);
  assert.equal(h.messages.length,3);
});

test('an import canceled by a tour cannot create an image after the tour closes',async()=>{
  const h=harness(),request=h.run('projectObservation(observation)');
  assert.equal(h.pending.length,1);
  h.active(true);h.run('cancelTourImageOverlays()');h.active(false);
  h.pending[0].resolve({wcs:{},original_url:'/original.fits'});await request;
  assert.equal(h.layers.length,0);assert.equal(h.visits.length,0);assert.equal(h.camera.length,0);
});

test('a pending FITS decode stays invisible and cannot move the tour camera',async()=>{
  const h=harness(),request=h.run('projectObservation(observation)');
  h.pending[0].resolve({wcs:{},original_url:'/original.fits'});await request;
  const layer=h.layers[0];assert.equal(layer.opacity,0);
  h.active(true);h.run('cancelTourImageOverlays()');
  layer.options.successCallback(42,13,.1);
  assert.equal(layer.opacity,0);assert.equal(h.camera.length,0);
  assert.equal(h.run('journeys.overlay'),null);assert.equal(h.$('#clear-science-overlay').hidden,true);
  h.active(false);layer.options.successCallback(43,14,.2);
  assert.equal(layer.opacity,0);assert.equal(h.camera.length,0);
});

test('only the current FITS request can reveal pixels or change the camera',async()=>{
  const h=harness(),first=h.run('projectObservation(observation)');
  h.pending[0].resolve({wcs:{},original_url:'/first.fits'});await first;
  const second=h.run('projectObservation(observation)');
  h.pending[1].resolve({wcs:{},original_url:'/second.fits'});await second;
  h.layers[1].options.successCallback(52,17,.2);
  assert.equal(h.layers[1].opacity,1);assert.equal(h.camera.length,2);
  h.layers[0].options.successCallback(11,12,.9);
  assert.equal(h.layers[0].opacity,0);assert.equal(h.camera.length,2);
  assert.deepEqual(h.camera[0],['position',52,17]);
});

test('research and measured map overlays work normally but stay canceled after tour entry',()=>{
  const h=harness();h.run('showResearchMosaic(mosaic);sdssOverlay()');
  assert.equal(h.layers.length,2);
  for(const layer of h.layers){assert.equal(layer.opacity,0);layer.options.successCallback();assert.equal(layer.opacity,1);}
  h.active(true);h.run('cancelTourImageOverlays()');
  assert.equal(h.run('researchUI.overlay'),null);assert.equal(h.run('sdssUI.overlay'),null);
  assert.equal(h.$('#research-mosaic-clear').hidden,true);assert.equal(h.$('#sdss-remove-overlay').disabled,true);
  assert.ok(h.removed.includes('research-mosaic'));assert.ok(h.removed.includes('sdss-manga'));
  h.active(false);
  for(const layer of h.layers){layer.options.successCallback();assert.equal(layer.opacity,0);}
});

test('entering the explorer cannot bypass the research image tour guard',()=>{
  const h=harness();h.c.showPage=()=>h.active(true);
  h.run('showResearchMosaic(mosaic)');
  assert.equal(h.layers.length,0);assert.equal(h.camera.length,0);
});

test('starting a flight cannot bypass the measured map tour guard',()=>{
  const h=harness();h.c.flyTo=()=>h.active(true);
  h.run('sdssOverlay()');assert.equal(h.layers.length,0);
});

test('canceled image errors do not produce misleading tour notifications',async()=>{
  const h=harness(),request=h.run('projectObservation(observation)');
  h.pending[0].resolve({wcs:{},original_url:'/original.fits'});await request;
  h.run('sdssOverlay()');h.active(true);h.run('cancelTourImageOverlays()');
  const count=h.messages.length;
  for(const layer of h.layers)layer.options.errorCallback();
  assert.equal(h.messages.length,count);
});
