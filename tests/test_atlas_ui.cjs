const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../static',name),'utf8');

function automatic(){
  let release,ready;const queued=new Promise(resolve=>ready=resolve),layers=[],nodes=new Map(),view={ra:12,dec:70,fov:.01};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='#atlas-opacity'?'85':'both',textContent:'',checked:true,disabled:false});return nodes.get(id);};
  const c=vm.createContext({$,console,Date,setTimeout:()=>1,clearTimeout(){},URLSearchParams,location:{origin:'http://127.0.0.1:8765'},
    state:{page:'explore',sky:{setOverlayImageLayer:layer=>layers.push(layer),removeImageLayer(){}}},
    currentField:()=>({...view}),api:async()=>({rows:[{id:'123',contains_view_center:true,mission:'JWST',filters:'F200W'}]}),
    jsonPost:()=>new Promise(resolve=>{release=resolve;ready();}),
    A:{image:(url,opts)=>({url,opts})},flight:{active:false},
  });
  vm.runInContext(source('flight-math.js')+source('atlas.js'),c);
  const run=s=>vm.runInContext(s,c);
  const result={state:'complete',result:{url:'/cutout',ra:12,dec:70,fov:.01,min_cut:0,max_cut:1}};
  return {c,$,view,layers,run,queued,finish:()=>release(result)};
}
test('late science responses never place an old field after the user moves away',async()=>{
  const p=automatic(),pending=p.run('loadAutomaticScience()');await p.queued;
  p.view.ra=30;p.finish();await pending;
  assert.equal(p.layers.length,0);assert.match(p.$('#atlas-message').textContent,/cached/);
});
test('turning automatic layers off invalidates in-flight responses',async()=>{
  const p=automatic(),pending=p.run('loadAutomaticScience()');await p.queued;
  p.run('atlasUI.enabled=false;atlasClear()');p.finish();await pending;assert.equal(p.layers.length,0);
});
test('a current science image preserves camera position and uses measured intensity cuts',async()=>{
  const p=automatic(),pending=p.run('loadAutomaticScience()');await p.queued;p.finish();await pending;
  assert.equal(p.layers.length,1);assert.equal(p.layers[0].opts.minCut,0);assert.equal(p.layers[0].opts.maxCut,1);
  assert.equal(p.layers[0].opts.opacity,.85);assert.equal(p.view.ra,12);
});
test('prepared tour renderings release to detailed tiles while downloaded packs remain visible',()=>{
  const p=automatic();p.run('atlasUI.packLayer={};atlasRetirePreview(atlasUI.packLayer)');assert.equal(p.run('atlasUI.packLayer'),null);
  p.run('atlasUI.pack={id:"saved"};atlasUI.packLayer={id:"view"};atlasRetirePreview(atlasUI.packLayer)');assert.equal(p.run('atlasUI.packLayer.id'),'view');
});

test('visible map detail pauses offscreen flight work and defers automatic science until tiles settle',async()=>{
  const p=automatic(),timers=new Map();let next=0;
  p.c.setTimeout=fn=>{timers.set(++next,fn);return next;};p.c.clearTimeout=id=>timers.delete(id);
  p.c.state.sky.isStillActive=()=>true;
  p.run('flight.active=true;flight.camera={};flight.velocity=[1,0,0,0];atlasWarmFlight()');
  assert.equal(p.run('atlasUI.warm'),null);
  await p.run('loadAutomaticScience()');await p.run('loadAutomaticScience()');
  assert.equal(p.run('atlasUI.busy'),false);assert.equal(timers.size,1);
  p.c.state.sky.isStillActive=()=>false;
  const pending=[...timers.values()][0]();await p.queued;p.finish();await pending;
  assert.equal(p.layers.length,1);
});

test('manual science loading remains available while the visible map is busy',async()=>{
  const p=automatic();p.c.state.sky.isStillActive=()=>true;
  const pending=p.run('loadAutomaticScience(true)');await p.queued;p.finish();await pending;
  assert.equal(p.layers.length,1);
});

test('upcoming tour previews wait for detail and discard a replaced tour',async()=>{
  const p=automatic(),timers=new Map(),requests=[];let next=0;
  p.c.setTimeout=fn=>{timers.set(++next,fn);return next;};p.c.clearTimeout=id=>timers.delete(id);
  p.c.jsonPost=async(url,body)=>{requests.push(body);return {state:'complete',result:{}};};
  p.c.route={kind:'waypoints',stops:[{ra:1,dec:0,fov:1,survey:'optical'},{ra:2,dec:0,fov:1,survey:'optical'}]};
  p.c.routePlayer={route:p.c.route,index:0};p.c.state.sky.isStillActive=()=>true;
  p.run('atlasPrefetch(route,0);atlasPrefetch(route,0)');
  assert.equal(timers.size,1);assert.equal(requests.length,0);
  const deferred=[...timers.values()][0];p.c.routePlayer.route={};deferred();assert.equal(requests.length,0);
  p.c.routePlayer.route=p.c.route;p.c.state.sky.isStillActive=()=>false;
  p.run('atlasPrefetch(route,0)');assert.equal(requests.length,1);assert.equal(requests[0].ra,2);
  p.c.state.sky.isStillActive=()=>true;p.run('atlasPrefetch(route,0);atlasStopPack()');assert.equal(timers.size,0);
});

test('map priority skips online rendered previews but retains downloaded tour images',async()=>{
  const p=automatic();p.c.route={id:'tour',revision:1,stops:[{ra:1,dec:0,fov:1,survey:'optical'}]};
  await p.run('atlasShowPackView(route,0)');assert.equal(p.layers.length,0);
  await p.run('atlasStopPack();atlasUI.pack={route_id:"tour",revision:1,views:[{index:0,view:{url:"/saved",survey_name:"Optical",wcs:{}}}]};atlasShowPackView(route,0)');
  assert.equal(p.layers.length,1);assert.equal(p.layers[0].url,'/saved');
});
test('comparison steering synchronizes position, zoom and rotation without repeated writes',()=>{
  const frames=[],calls=[],nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);};
  const left={getRaDec:()=>[359.99,89.9],getFov:()=>[.01,.01],getRotation:()=>31};
  const right={gotoRaDec:(...v)=>calls.push(['position',...v]),setFoV:v=>calls.push(['fov',v]),setRotation:v=>calls.push(['rotation',v]),getRaDec:left.getRaDec,getFov:left.getFov,getRotation:left.getRotation};
  const c=vm.createContext({$,left,right,requestAnimationFrame:fn=>{frames.push(fn);return frames.length;}});
  vm.runInContext(source('comparison.js'),c);vm.runInContext('compareUI.left=left;compareUI.right=right;syncComparison();syncComparison();',c);
  assert.equal(frames.length,1);frames.shift()();
  assert.deepEqual(calls,[['position',359.99,89.9],['fov',.01],['rotation',31]]);
  vm.runInContext('syncComparison()',c);frames.shift()();assert.equal(calls.length,3);
});
test('comparison blend endpoints and swipe divider do not expose old clipping',()=>{
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'50',textContent:'',style:{},hidden:false});return nodes.get(id);};
  const c=vm.createContext({$});vm.runInContext(source('comparison.js'),c);
  $('#compare-mode').value='swipe';$('#compare-slider').value='100';vm.runInContext('compareBlend()',c);
  assert.equal($('#compare-right-map').style.clipPath,'inset(0 0 0 100%)');
  $('#compare-mode').value='blend';$('#compare-slider').value='0';vm.runInContext('compareBlend()',c);
  assert.equal($('#compare-right-map').style.clipPath,'none');assert.equal($('#compare-right-map').style.opacity,0);assert.equal($('#compare-divider').hidden,true);
});
