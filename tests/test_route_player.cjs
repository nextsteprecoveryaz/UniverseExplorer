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
  const context=vm.createContext({$,api,console,structuredClone,Image:class{constructor(){throw Error('Tours must not request photo previews');}},
    atlasUI:{pack:null},atlasPrefetch(){},atlasShowPackView(){},atlasStopPack(){},atlasClear(){},
    state:{page:'explore',config:{surveys:[{id:'optical',name:'Visible'},{id:'2mass',name:'Near-infrared'},{id:'hydrogen',name:'H-alpha'},{id:'dust',name:'Dust'},{id:'webb-color',name:'Webb'}]},sky:{setProjection(v){calls.push(['projection',v]);},gotoRaDec(...v){calls.push(['position',...v]);},setFoV(v){calls.push(['fov',v]);},setRotation(v){calls.push(['roll',v]);},removeImageLayer(){},isStillActive:()=>false}},
    navigationUI:{dirty:false},flight:{active:false},storySourcesMarkup:()=>'',drawNavigationFootprint(){},setNearbyVisible(){},chooseSurvey(v){calls.push(['survey',v]);},setInterval(){},failure(e){throw e;},flightEditable:()=>false,
    routePayload:r=>({title:r.title,kind:r.kind,stops:r.stops||[],track:r.track||[]}),
    performance:{now:()=>clock},requestAnimationFrame(fn){frames.set(++frameId,fn);return frameId;},cancelAnimationFrame(id){frames.delete(id);},
    document:{hidden:false,hasFocus:()=>true,querySelectorAll:()=>[],addEventListener(k,f){events[k]=f;}},window:{addEventListener(k,f){windowEvents[k]=f;}}
  });
  for(const file of ['flight-math.js','route-timeline.js','tour-display.js','route-player.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../static',file),'utf8'),context);
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

test('resuming after manual exploration restores the sky before waiting for tiles',()=>{
  const p=player(),removed=[];let scienceCleared=0,requestsCancelled=0,packRefreshes=0;
  p.context.atlasClear=()=>scienceCleared++;
  p.context.cancelTourImageOverlays=()=>requestsCancelled++;
  p.context.atlasShowPackView=()=>packRefreshes++;
  p.context.state.sky.isStillActive=()=>true;
  p.run('state.sky.removeImageLayer=id=>removedLayers.push(id)');
  p.context.removedLayers=removed;
  p.$('#route-player').hidden=true;
  p.run('resumeRoute()');
  assert.equal(scienceCleared,1);assert.equal(requestsCancelled,1);
  assert.deepEqual(removed,['selected-science-image','research-mosaic','sdss-manga']);
  assert.equal(p.$('#route-player').hidden,false);
  assert.equal(p.calls.filter(c=>c[0]==='position').length,1);
  assert.deepEqual(p.calls.filter(c=>c[0]==='survey'),[['survey','optical']]);
  assert.equal(packRefreshes,1);
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

test('a broken source photo cannot pause a survey-only tour',()=>{
  const p=player();p.run('resumeRoute()');p.$('#route-stop-image').dataset.loaded='error';p.advance();
  assert.equal(p.run('routePlayer.playing'),true);assert.ok(p.run('routePlayer.elapsed')>1);
});

test('Next while paused lands on the target rather than labeling the departure view',()=>{
  const p=player();p.run(`routePlayer.route.stops.push({...stop,title:'Next field',ra:210});routePlayer.route.media.push(null);routePlayer.timeline=RouteTimeline.build(routePlayer.route,stop);skipRouteStop(1);`);
  assert.equal(p.run('routePlayer.elapsed'),32);
  assert.equal(p.run('routePlayer.lastView.ra'),210);
  assert.equal(p.run('routePlayer.playing'),false);
});

test('route pause/resume and Next call narration lifecycle hooks',()=>{
  const p=player(),events=[];
  p.context.pauseTourNarration=()=>events.push('pause');
  p.context.resumeTourNarration=()=>events.push('resume');
  p.context.resetTourNarration=()=>events.push('reset');
  p.run('resumeRoute();pauseRoute()');
  assert.deepEqual(events,['resume','pause']);
  p.run(`routePlayer.route.stops.push({...stop,title:'Next',ra:210});routePlayer.route.media.push(null);routePlayer.timeline=RouteTimeline.build(routePlayer.route,stop);skipRouteStop(1);`);
  assert.ok(events.includes('reset'));
  assert.equal(p.run('routePlayer.index'),1);
  const before=events.filter(event=>event==='reset').length;
  p.run('closeRoutePlayer()');
  assert.equal(events.filter(event=>event==='reset').length,before+1);
  assert.equal(p.run('routePlayer.route'),null);
});

test('narration starts once after arrival and waits at the end of the hold before advancing',()=>{
  const p=player();let starts=0,pending=true;
  p.context.startTourNarration=()=>{starts++;};
  p.context.tourNarrationPending=()=>pending;
  p.run(`routePlayer.route.stops.push({...stop,title:'Next',ra:210});routePlayer.route.media.push(null);routePlayer.timeline=RouteTimeline.build(routePlayer.route,stop);routePlayer.elapsed=30.99;resumeRoute();`);
  for(let i=0;i<8;i++)p.advance();
  assert.equal(starts,1);
  assert.equal(p.run('routePlayer.index'),0);assert.equal(p.run('routePlayer.elapsed'),30.99);
  assert.match(p.$('#route-play-status').textContent,/Listening to narration/);
  pending=false;p.advance();
  assert.equal(p.run('routePlayer.index'),1);
  assert.ok(p.run('routePlayer.elapsed')>31);
});

test('the last stop waits for narration before marking the journey complete',()=>{
  const p=player();let pending=true;
  p.context.startTourNarration=()=>{};
  p.context.tourNarrationPending=()=>pending;
  p.run('routePlayer.elapsed=30.99;resumeRoute()');p.advance();
  assert.equal(p.run('routePlayer.playing'),true);
  assert.equal(p.run('routePlayer.elapsed'),30.99);
  pending=false;p.advance();
  assert.equal(p.run('routePlayer.playing'),false);
  assert.equal(p.run('routePlayer.elapsed'),31);
  assert.match(p.$('#route-play-status').textContent,/Journey complete/);
});

test('explicit Next can leave a stop while narration is pending',()=>{
  const p=player();let resets=0;
  p.context.startTourNarration=()=>{};
  p.context.tourNarrationPending=()=>true;
  p.context.resetTourNarration=()=>{resets++;};
  p.run(`routePlayer.route.stops.push({...stop,title:'Next',ra:210});routePlayer.route.media.push(null);routePlayer.timeline=RouteTimeline.build(routePlayer.route,stop);routePlayer.elapsed=30.99;resumeRoute();`);
  p.advance();p.run('skipRouteStop(1)');
  assert.equal(p.run('routePlayer.index'),1);
  assert.equal(p.run('routePlayer.elapsed'),31);
  assert.equal(p.run('routePlayer.playing'),true);
  assert.equal(resets,1);
});

test('researched narration replaces navigation notes without repeating catalog titles',()=>{
  const p=player();
  p.context.researchedStory='  A giant black hole.\n  A surprising discovery.';
  assert.equal(p.run(`narrationFor({narration:researchedStory,description:'Old navigation notes.'},{title:'M87',notes:'Personal note'})`),'A giant black hole. A surprising discovery.');
  assert.equal(p.run(`narrationFor({description:'An existing gallery story.'},{title:'Carina'})`),'Carina. An existing gallery story.');
  assert.equal(p.run(`narrationFor({narration:'   '},{title:'My target',notes:'My own notes.'})`),'My target. My own notes.');
});

test('moving between stops and recordings clears the previous story sources',()=>{
  const p=player();p.context.storySourcesMarkup=m=>m?.story_sources?.[0]?.title||'';
  p.run(`routePlayer.route.media[0]={story_sources:[{title:'NASA research'}]};updateRouteGuide(0)`);
  assert.equal(p.$('#route-story-sources').innerHTML,'NASA research');
  p.run(`routePlayer.route.media[0]=null;updateRouteGuide(0)`);
  assert.equal(p.$('#route-story-sources').innerHTML,'');
  p.run(`routePlayer.route.kind='recording';updateRouteGuide(0)`);
  assert.equal(p.$('#route-story-sources').innerHTML,'');
});

test('legacy telescope stops, travel frames and recordings keep one selected full-sky survey',()=>{
  const p=player();p.run(`tourSkyChoice='2mass';routePlayer.route.stops[0].survey='webb-color';routePlayer.route.media[0]={preview_url:'/photo.jpg',video_url:'/movie.mp4'};routePlayer.route.media.push({preview_url:'/next-photo.jpg'});applyRouteFrame({index:0,phase:'hold',view:{...stop,survey:'hubble-color'}});updateRouteGuide(0)`);
  assert.deepEqual(p.calls.filter(c=>c[0]==='survey'),[['survey','2mass']]);
  assert.equal(p.$('#route-stop-image').hidden,true);assert.equal(p.$('#route-stop-image').dataset.loaded,'none');
  assert.equal(p.$('#route-stop-video').hidden,true);assert.equal(p.run('routePlayer.prefetch.length'),0);
  p.run(`applyRouteFrame({index:0,phase:'travel',view:{...stop,survey:'optical'}})`);
  assert.equal(p.calls.filter(c=>c[0]==='survey').length,1);
  p.run(`routePlayer.route.kind='recording';applyRouteFrame({index:0,phase:'hold',view:{...stop,survey:'webb-200'}})`);
  assert.equal(p.calls.filter(c=>c[0]==='survey').length,1);
});

test('playback survey conversion preserves the saved document, source story, notes and progress',()=>{
  const p=player();p.run(`var saved={...routePlayer.route,stops:[{...stop,survey:'cefca-virgo',notes:'My note'}],track:[{...stop,t:0,survey:'webb-color'}],progress:{elapsed:12,origin:{...stop,survey:'webb-444'}},media:[{narration:'A researched story.',preview_url:'/source.jpg'}]};var displayed=tourSurveyRoute(saved)`);
  assert.equal(p.run('saved.stops[0].survey'),'cefca-virgo');
  assert.equal(p.run('displayed.stops[0].survey'),'optical');assert.equal(p.run('displayed.track[0].survey'),'optical');assert.equal(p.run('displayed.progress.origin.survey'),'optical');
  assert.equal(p.run('displayed.stops[0].notes'),'My note');assert.equal(p.run('displayed.media[0].narration'),'A researched story.');
  assert.equal(p.run(`setTourSkySurvey('webb-color')`),false);assert.equal(p.run('tourSkySurvey()'),'optical');
});

test('changing the tour sky updates the map without restarting narration or moving its position',()=>{
  const p=player();let resets=0;p.context.resetTourNarration=()=>resets++;
  p.run('routePlayer.elapsed=12;resumeRoute();applyRouteFrame(RouteTimeline.at(routePlayer.timeline,12))');
  const ra=p.run('routePlayer.lastView.ra');p.run(`setTourSkySurvey('2mass')`);
  assert.equal(p.run('routePlayer.lastView.ra'),ra);assert.equal(p.run('routePlayer.elapsed'),12);assert.equal(p.run('routePlayer.playing'),true);assert.equal(resets,0);
  assert.equal(p.run('routePlayer.survey'),'2mass');assert.equal(p.run('routePlayer.route.stops[0].survey'),'2mass');
});

test('native layers that finish decoding late cannot add photos during a tour',()=>{
  const p=player(),removed=[];let added;
  p.context.state.sky.addListener=(name,handler)=>{assert.equal(name,'AL:Layer.added');added=handler;};
  const base={layer:'native-base-uuid'};p.context.state.sky.getBaseImageLayer=()=>base;
  p.context.state.sky.removeImageLayer=key=>removed.push(key);
  p.run('installTourLayerGuard(state.sky)');
  added({detail:{layer:base}});
  added({detail:{layer:{layer:'selected-science-image'}}});
  added({detail:{layer:{layer:'science-trail-old'}}});
  added({detail:{layer:{layer:'downloaded-tour-view'}}});
  const prepared={layer:'downloaded-tour-view'};p.context.prepared=prepared;p.run('atlasUI.packLayer=prepared');added({detail:{layer:prepared}});
  assert.deepEqual(removed,['selected-science-image','science-trail-old','downloaded-tour-view']);
  p.run('closeRoutePlayer()');added({detail:{layer:{layer:'outside-tour'}}});
  assert.ok(!removed.includes('outside-tour'));
});
