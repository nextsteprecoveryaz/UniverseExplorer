const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../static',name),'utf8');

function automatic(){
  let release,ready;const queued=new Promise(resolve=>ready=resolve),layers=[],removed=[],nodes=new Map(),view={ra:12,dec:70,fov:.01};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='#atlas-opacity'?'85':'both',textContent:'',checked:true,disabled:false});return nodes.get(id);};
  const c=vm.createContext({$,console,Date,structuredClone,setTimeout:()=>1,clearTimeout(){},URLSearchParams,location:{origin:'http://127.0.0.1:8765'},
    state:{page:'explore',sky:{setOverlayImageLayer:layer=>layers.push(layer),removeImageLayer:id=>removed.push(id)}},
    tourChoice:'optical',tourActive:false,
    currentField:()=>({...view}),api:async()=>({rows:[{id:'123',contains_view_center:true,mission:'JWST',filters:'F200W'}]}),
    jsonPost:()=>new Promise(resolve=>{release=resolve;ready();}),
    A:{image:(url,opts)=>({url,opts,opacity:opts.opacity,setOpacity(value){this.opacity=value;}})},flight:{active:false},
  });
  vm.runInContext(`
    function tourSkySurvey(){return tourChoice;}
    function tourSkySurveys(){return ['optical','2mass','hydrogen','dust'].map(id=>({id}));}
    function tourSurveyActive(){return tourActive;}
    function tourSurveyView(view){return {...view,survey:tourChoice};}
    function tourSurveyRoute(route){const copy=structuredClone(route);copy.stops=(copy.stops||[]).map(tourSurveyView);copy.track=(copy.track||[]).map(tourSurveyView);if(copy.progress?.origin)copy.progress.origin=tourSurveyView(copy.progress.origin);return copy;}
  `+source('flight-math.js')+source('atlas.js'),c);
  const run=s=>vm.runInContext(s,c);
  const result={state:'complete',result:{url:'/cutout',ra:12,dec:70,fov:.01,min_cut:0,max_cut:1}};
  return {c,$,view,layers,removed,run,queued,finish:()=>release(result)};
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
  assert.equal(p.layers[0].opacity,0);p.layers[0].opts.successCallback();assert.equal(p.layers[0].opacity,.85);assert.equal(p.view.ra,12);
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
  p.c.routePlayer={route:p.c.route,index:0};
  await p.run('atlasShowPackView(route,0)');assert.equal(p.layers.length,0);
  await p.run('atlasStopPack();atlasUI.pack={route_id:"tour",revision:1,views:[{index:0,view:{url:"/saved",survey:"optical",survey_name:"Optical",wcs:{}}}]};atlasShowPackView(route,0)');
  assert.equal(p.layers.length,1);assert.equal(p.layers[0].url,'/saved');
  assert.equal(p.layers[0].opacity,0);p.layers[0].opts.successCallback();assert.equal(p.layers[0].opacity,1);
});
test('tour prefetch maps every upcoming stop onto the selected continuous survey without changing saved stops',async()=>{
  const p=automatic(),requests=[];
  p.c.state.config={surveys:[{id:'cefca-virgo',rendered_views:false},{id:'optical'}]};
  p.c.tourChoice='2mass';
  p.c.jsonPost=async(url,body)=>{requests.push({url,body});return {state:'complete',result:{}};};
  p.c.route={kind:'waypoints',stops:[
    {ra:1,dec:0,fov:.2,survey:'optical'},
    {ra:187.7,dec:12.3,fov:.2,survey:'cefca-virgo'},
    {ra:2,dec:0,fov:.2,survey:'optical'},
  ]};
  p.run('atlasPrefetch(route,0)');
  assert.equal(requests.length,2);
  assert.equal(requests[0].url,'/api/atlas/view');
  assert.equal(requests[0].body.survey,'2mass');assert.equal(requests[1].body.survey,'2mass');
  assert.equal(requests[0].body.ra,187.7);assert.equal(requests[1].body.ra,2);
  assert.equal(p.c.route.stops[1].survey,'cefca-virgo');
  assert.equal(p.run('atlasUI.prefetched.size'),2);
});

test('online prepared views replace sparse source surveys with the selected full-sky survey',async()=>{
  const p=automatic(),requests=[];
  p.c.state.config={surveys:[{id:'cefca-virgo',rendered_views:false}]};
  p.c.jsonPost=async(url,body)=>{requests.push({url,body});return {state:'complete',result:{survey:body.survey,url:'/prepared',wcs:{}}};};
  p.c.route={id:'cefca-tour',revision:1,stops:[{ra:187.7,dec:12.3,fov:.2,survey:'cefca-virgo'}]};
  p.c.routePlayer={route:p.c.route,index:0};
  p.run('atlasUI.detailPriority=false');
  await p.run('atlasShowPackView(route,0)');
  assert.equal(requests.length,1);assert.equal(requests[0].body.survey,'optical');
  assert.equal(p.layers.length,1);
  assert.equal(p.layers[0].url,'/prepared');
  assert.equal(p.c.route.stops[0].survey,'cefca-virgo');
});

test('a survey opting out of automatic science schedules no download but manual loading remains available',async()=>{
  const p=automatic(),timers=[],queries=[];
  p.c.state.config={surveys:[{id:'cefca-virgo',auto_science:false}]};
  p.c.state.survey='cefca-virgo';p.c.state.fov=p.view.fov;
  p.c.setTimeout=fn=>{timers.push(fn);return timers.length;};
  const api=p.c.api;p.c.api=async url=>{queries.push(url);return api(url);};
  p.run('onAtlasViewChanged()');
  await p.run('loadAutomaticScience()');
  assert.equal(queries.length,0);assert.equal(timers.length,0);
  assert.match(p.$('#atlas-message').textContent,/Load here/);
  const pending=p.run('loadAutomaticScience(true)');await p.queued;p.finish();await pending;
  assert.equal(queries.length,1);
  assert.equal(p.layers.length,1);
});

test('a late automatic cutout cannot cover a newly selected survey that opts out',async()=>{
  const p=automatic();
  p.c.state.config={surveys:[{id:'optical'},{id:'cefca-virgo',auto_science:false}]};
  p.c.state.survey='optical';
  const pending=p.run('loadAutomaticScience()');await p.queued;
  p.c.state.survey='cefca-virgo';p.finish();await pending;
  assert.equal(p.layers.length,0);
  assert.equal(p.run('atlasUI.busy'),false);
  assert.match(p.$('#atlas-message').textContent,/cached/);
});

test('an open tour blocks automatic and manual science and their view-change scheduler',async()=>{
  const p=automatic(),requests=[],timers=[];p.c.tourActive=true;p.c.state.fov=.1;
  p.c.api=async url=>{requests.push(url);return {rows:[]};};
  p.c.setTimeout=fn=>{timers.push(fn);return timers.length;};
  p.run('onAtlasViewChanged()');await p.run('loadAutomaticScience()');await p.run('loadAutomaticScience(true)');
  assert.equal(requests.length,0);assert.equal(timers.length,0);assert.equal(p.layers.length,0);
  assert.match(p.$('#atlas-message').textContent,/full-sky survey/);
});

test('starting a tour during the footprint lookup prevents a science download',async()=>{
  const p=automatic();let resolve,prepares=0;
  p.c.api=()=>new Promise(done=>{resolve=done;});p.c.jsonPost=()=>{prepares++;throw Error('Unexpected prepare');};
  const pending=p.run('loadAutomaticScience()');p.c.tourActive=true;
  resolve({rows:[{id:'old',contains_view_center:true}]});await pending;
  assert.equal(prepares,0);assert.equal(p.run('atlasUI.busy'),false);
});

test('starting a tour while the science job is pending discards its result',async()=>{
  const p=automatic(),pending=p.run('loadAutomaticScience(true)');await p.queued;
  p.c.tourActive=true;p.finish();await pending;
  assert.equal(p.layers.length,0);assert.equal(p.run('atlasUI.busy'),false);
});

test('a native science-layer callback stays invisible when a tour starts or its field changes',async()=>{
  for(const invalidate of [p=>{p.c.tourActive=true;},p=>{p.view.ra=140;}]){
    const p=automatic(),pending=p.run('loadAutomaticScience()');await p.queued;p.finish();await pending;
    invalidate(p);p.layers[0].opts.successCallback();
    assert.equal(p.layers[0].opacity,0);assert.equal(p.run('atlasUI.loaded'),null);
  }
});

test('a queued science refinement cannot run over an open tour',async()=>{
  const p=automatic(),timers=[];let queries=0;
  const api=p.c.api;p.c.api=async url=>{queries++;return api(url);};
  p.c.setTimeout=fn=>{timers.push(fn);return timers.length;};
  const pending=p.run('loadAutomaticScience()');await p.queued;p.finish();await pending;
  p.layers[0].opts.successCallback();assert.equal(timers.length,1);
  p.c.tourActive=true;timers[0]();await Promise.resolve();
  assert.equal(queries,1);
});

test('prepared views discard late responses across survey changes, including switching back',async()=>{
  const p=automatic(),pending=[];
  p.c.route={id:'tour',revision:1,stops:[{ra:1,dec:2,fov:.3,survey:'cefca-virgo'}]};
  p.c.routePlayer={route:p.c.route,index:0};p.run('atlasUI.detailPriority=false');
  p.c.jsonPost=(url,body)=>new Promise(resolve=>pending.push({body,resolve}));
  const first=p.run('atlasShowPackView(route,0)');
  p.c.tourChoice='2mass';const second=p.run('atlasShowPackView(route,0)');
  p.c.tourChoice='optical';const third=p.run('atlasShowPackView(route,0)');
  assert.deepEqual(pending.map(job=>job.body.survey),['optical','2mass','optical']);
  pending[0].resolve({state:'complete',result:{url:'/old-visible',survey:'optical'}});await first;
  pending[1].resolve({state:'complete',result:{url:'/old-infrared',survey:'2mass'}});await second;
  assert.equal(p.layers.length,0);
  pending[2].resolve({state:'complete',result:{url:'/current-visible',survey:'optical'}});await third;
  assert.equal(p.layers.length,1);assert.equal(p.layers[0].url,'/current-visible');
});

test('legacy, unknown, and differently selected pack surveys clear old images and never overlay',async()=>{
  for(const savedSurvey of ['cefca-virgo','webb-color','2mass',undefined]){
    const p=automatic();p.c.route={id:'tour',revision:1,stops:[{ra:1,dec:2,fov:.3}]};
    p.c.routePlayer={route:p.c.route,index:0};
    p.c.pack={route_id:'tour',revision:1,views:[{index:0,view:{url:'/legacy',survey:savedSurvey}}]};
    await p.run('atlasUI.pack=pack;atlasUI.packLayer={old:true};atlasShowPackView(route,0)');
    assert.deepEqual(p.removed,['downloaded-tour-view']);assert.equal(p.layers.length,0);
    assert.equal(p.run('atlasUI.packLayer'),null);assert.match(p.$('#atlas-message').textContent,/another survey/);
  }
});

test('wrong route revisions clear a prior pack layer before rejecting the saved view',async()=>{
  const p=automatic();p.c.route={id:'tour',revision:2,stops:[]};p.c.routePlayer={route:p.c.route,index:0};
  await p.run('atlasUI.packLayer={};atlasUI.pack={route_id:"tour",revision:1,views:[{index:0,view:{survey:"optical",url:"/old"}}]};atlasShowPackView(route,0)');
  assert.deepEqual(p.removed,['downloaded-tour-view']);assert.equal(p.layers.length,0);
});

test('a pending native pack image never reveals after its survey changes or the tour closes',async()=>{
  for(const invalidate of [p=>{p.c.tourChoice='2mass';},p=>{p.run('atlasStopPack()');}]){
    const p=automatic();p.c.route={id:'tour',revision:1,stops:[{}]};p.c.routePlayer={route:p.c.route,index:0};
    await p.run('atlasUI.pack={route_id:"tour",revision:1,views:[{index:0,view:{survey:"optical",url:"/saved"}}]};atlasShowPackView(route,0)');
    invalidate(p);p.layers[0].opts.successCallback();
    assert.equal(p.layers[0].opacity,0);assert.equal(p.run('atlasUI.packLayer'),null);
  }
});

test('playing legacy downloads keeps route facts but removes photo previews and uses the chosen survey',async()=>{
  const p=automatic();let played;p.c.tourChoice='2mass';p.c.startRouteDocument=async(route,pack)=>{played={route,pack};};
  p.c.saved={id:'pack',route:{id:'tour',stops:[{ra:1,survey:'cefca-virgo'}],track:[{survey:'webb-color'}],progress:{origin:{survey:'optical'}},media:[{description:'Original narration',preview_url:'/source.jpg'}]},views:[{index:0,preview_url:'/downloaded.jpg',preview_error:'Old failure'}]};
  await p.run('playAtlasPack(saved)');
  assert.equal(played.route.stops[0].survey,'2mass');assert.equal(played.route.track[0].survey,'2mass');assert.equal(played.route.progress.origin.survey,'2mass');
  assert.equal(played.route.media[0].preview_url,null);assert.equal(played.route.media[0].description,'Original narration');
  assert.equal(p.c.saved.route.media[0].preview_url,'/source.jpg');assert.equal(p.c.saved.route.stops[0].survey,'cefca-virgo');
  assert.equal(played.pack,p.c.saved);
});

test('download controls request the chosen survey and manual load leaves an active tour unchanged',async()=>{
  const p=automatic(),created=[],requests=[];
  const element=()=>({dataset:{},append(){},before(){},after(){},innerHTML:''});
  p.c.document={createElement:()=>{const node=element();created.push(node);return node;}};
  p.c.localStorage={getItem:()=>null};p.c.busy=async(button,label,fn)=>fn();
  p.c.api=async(url,options)=>{requests.push({url,options});return {cached_only:false,id:'job'};};
  for(const id of ['nav[aria-label="Workspace"]','.sidebar-footer','main','.atlas-cache-bar'])Object.assign(p.$(id),element());
  p.run('loadAtlasDownloads=async()=>{};initAtlas()');
  assert.match(created.find(node=>node.id==='downloads-page').innerHTML,/id="atlas-download-survey" data-tour-sky/);
  p.c.tourChoice='dust';p.$('#atlas-download-route').value='tour/id';
  await p.$('#atlas-download-start').onclick();
  assert.equal(requests.at(-1).url,'/api/atlas/packs/tour%2Fid?survey=dust');assert.equal(requests.at(-1).options.method,'POST');
  p.c.tourActive=true;p.run('atlasUI.enabled=false');p.$('#atlas-load').onclick();
  assert.equal(p.run('atlasUI.enabled'),false);assert.equal(requests.length,2);
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
