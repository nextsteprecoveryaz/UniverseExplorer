const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function player(api=async()=>({revision:2})){
  const nodes=new Map(),frames=new Map(),events={},windowEvents={},calls=[];
  let clock=0,frameId=0;
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'1',hidden:false,open:false,checked:false,textContent:'',dataset:{loaded:'none'},style:{},classList:{add(){},remove(){}},addEventListener(){},removeAttribute(){}});
    return nodes.get(id);
  };
  const context=vm.createContext({$,api,console,Image:class{},
    atlasUI:{pack:null},atlasPrefetch(){},atlasShowPackView(){},atlasStopPack(){},atlasClear(){},
    state:{page:'explore',config:{surveys:[{id:'optical',name:'Visible'}]},sky:{setProjection(v){calls.push(['projection',v]);},gotoRaDec(...v){calls.push(['position',...v]);},setFoV(v){calls.push(['fov',v]);},setRotation(v){calls.push(['roll',v]);},isStillActive:()=>false}},
    navigationUI:{dirty:false},flight:{active:false},drawNavigationFootprint(){},setNearbyVisible(){},chooseSurvey(v){calls.push(['survey',v]);},setInterval(){},failure(e){throw e;},flightEditable:()=>false,
    routePayload:r=>({title:r.title,kind:r.kind,stops:r.stops||[],track:r.track||[]}),
    performance:{now:()=>clock},requestAnimationFrame(fn){frames.set(++frameId,fn);return frameId;},cancelAnimationFrame(id){frames.delete(id);},
    document:{hidden:false,hasFocus:()=>true,addEventListener(k,f){events[k]=f;}},window:{addEventListener(k,f){windowEvents[k]=f;}}
  });
  for(const file of ['flight-math.js','route-timeline.js','route-player.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../static',file),'utf8'),context);
  vm.runInContext(`initRoutePlayer();var stop={ra:159.216,dec:-58.621,fov:.15,roll:0,survey:'optical',projection:'AIT',travel:1,hold:30,title:'Carina',notes:''};routePlayer.route={id:'one',revision:1,title:'Tour',kind:'waypoints',stops:[stop],media:[null]};routePlayer.timeline=RouteTimeline.build(routePlayer.route,stop);routePlayer.index=0;routePlayer.elapsed=1;`,context);
  const run=s=>vm.runInContext(s,context);
  const advance=()=>{clock+=16;const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(clock);};
  return {$,run,advance,calls,frames,windowEvents,events,context};
}

test('a held waypoint does not continually reset imagery and tile loading',()=>{
  const p=player();p.run('resumeRoute()');for(let i=0;i<20;i++)p.advance();
  assert.equal(p.calls.filter(c=>c[0]==='position').length,1);
  assert.equal(p.calls.filter(c=>c[0]==='fov').length,1);
  assert.ok(p.run('routePlayer.elapsed')>1.25);
});

test('pause stops camera movement and resume reapplies the saved survey',()=>{
  const p=player();p.run('resumeRoute()');p.advance();p.windowEvents.blur();
  const elapsed=p.run('routePlayer.elapsed');p.advance();assert.equal(p.run('routePlayer.elapsed'),elapsed);assert.equal(p.frames.size,0);
  p.run('resumeRoute()');p.advance();assert.equal(p.calls.filter(c=>c[0]==='survey').length,2);
});

test('progress saves are serialized so a late response cannot revert a newer seek',async()=>{
  let release;const requests=[];
  const p=player(async(url,o)=>{requests.push(JSON.parse(o.body));if(requests.length===1)await new Promise(r=>release=r);return {saved:true};});
  const first=p.run('saveRouteProgress()');await Promise.resolve();
  p.run('routePlayer.elapsed=12');const second=p.run('saveRouteProgress()');await Promise.resolve();
  assert.equal(requests.length,1);release();await Promise.all([first,second]);assert.deepEqual(requests.map(r=>r.elapsed),[1,12]);
});

test('stopping during autosave flushes all final samples using the new revision',async()=>{
  let release;const requests=[];
  const p=player(async(url,o)=>{requests.push(JSON.parse(o.body));if(requests.length===1)await new Promise(r=>release=r);return {revision:requests.length+1,updated_at:'now'};});
  p.run(`routeRecorder.route={id:'flight',revision:1,title:'Flight',kind:'recording',track:[{...stop,t:0}]};`);
  const first=p.run('saveRecording()');await Promise.resolve();
  p.run('routeRecorder.route.track.push({...stop,t:.5})');const final=p.run('saveRecording()');release();await Promise.all([first,final]);
  assert.deepEqual(requests.map(r=>r.revision),[1,2]);assert.deepEqual(requests.map(r=>r.track.length),[1,2]);assert.equal(p.run('routeRecorder.route.revision'),3);
});

test('a failed source preview pauses before consuming the exploration time',()=>{
  const p=player();p.run('resumeRoute()');p.$('#route-stop-image').dataset.loaded='error';p.advance();
  assert.equal(p.run('routePlayer.playing'),false);assert.equal(p.run('routePlayer.elapsed'),1);assert.match(p.$('#route-play-status').textContent,/Preview unavailable/);
});

test('Next while paused lands on the target rather than labeling the departure view',()=>{
  const p=player();p.run(`routePlayer.route.stops.push({...stop,title:'Next field',ra:210});routePlayer.route.media.push(null);routePlayer.timeline=RouteTimeline.build(routePlayer.route,stop);skipRouteStop(1);`);
  assert.equal(p.run('routePlayer.elapsed'),32);
  assert.equal(p.run('routePlayer.lastView.ra'),210);
  assert.equal(p.run('routePlayer.playing'),false);
});
