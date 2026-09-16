const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(){
  const nodes=new Map(),layers=[],removed=[],surveys=[],listeners=new Map(),events=new Map();
  const element=id=>{
    if(!nodes.has(id)){
      const classes=new Set();
      nodes.set(id,{id:id.replace(/^#/,''),value:'1',hidden:false,disabled:false,open:false,checked:false,textContent:'',innerHTML:'',dataset:{},style:{},
        classList:{add(...values){values.forEach(v=>classes.add(v));},remove(...values){values.forEach(v=>classes.delete(v));},toggle(v,on){if(on??!classes.has(v))classes.add(v);else classes.delete(v);},contains:v=>classes.has(v)},
        setAttribute(){},removeAttribute(name){delete this[name];},addEventListener(){}});
    }
    return nodes.get(id);
  };
  const ids=['optical','2mass','hydrogen','dust','sdss-color','sdss-g','sdss-r','sdss-i','webb-color'];
  const options=ids.map(value=>({value,disabled:false})),chips=ids.map(survey=>({dataset:{survey},disabled:false,classList:{toggle(){}}}));
  const selectors=[element('#tour-sky-choice')];
  const sky={ra:12,dec:3,fov:1,projection:'AIT',rotation:0,base:{layer:'native-base'},
    getRaDec(){return [this.ra,this.dec];},getFov(){return [this.fov];},getRotation(){return this.rotation;},getProjectionName(){return this.projection;},getBaseImageLayer(){return this.base;},
    gotoRaDec(ra,dec){this.ra=ra;this.dec=dec;},setFoV(fov){this.fov=fov;},setRotation(roll){this.rotation=roll;},setProjection(projection){this.projection=projection;},
    setImageSurvey(url){surveys.push(url);},isStillActive:()=>false,removeOverlay(){},
    addListener(name,handler){listeners.set(name,handler);},removeImageLayer(key){removed.push(key);},
    setOverlayImageLayer(layer,key){layer.layer=key;listeners.get('AL:Layer.added')?.({detail:{layer}});}
  };
  let frame=0;
  const context=vm.createContext({console,structuredClone,URLSearchParams,AbortSignal,Event,
    document:{hidden:false,querySelector:element,querySelectorAll(selector){
      if(selector==='[data-tour-sky]')return selectors;
      if(selector==='#survey-select option')return options;
      if(selector==='#lens-chips button')return chips;
      if(selector==='.page')return [element('#explore-page'),element('#sdss-page')];
      return [];
    },addEventListener(name,handler){events.set(name,handler);}},
    window:{dispatchEvent(){},addEventListener(){}},location:{origin:'http://test.local'},
    localStorage:{getItem:()=>null,setItem(){}},performance:{now:()=>100},
    requestAnimationFrame:()=>++frame,cancelAnimationFrame(){},setTimeout:()=>1,clearTimeout(){},setInterval(){},clearInterval(){},
    fetch:async()=>({ok:true,json:async()=>({})}),
    flight:{active:false},navigationUI:{nearbyPreference:true,footprint:null},
    exitFlight(){},setNearbyVisible(){},stopObjectVideo(){},stopStellarMotion(){},storySourcesMarkup:()=>'',drawNavigationFootprint(){},flightEditable:()=>false,
    animateSkyTravel(_from,to){sky.gotoRaDec(to.ra,to.dec);sky.setFoV(to.fov);},
    A:{image(url,settings){const layer={url,settings,opacity:settings.opacity,setOpacity(value){this.opacity=value;}};layers.push(layer);return layer;}}
  });
  // Load the real navigation, survey, player and overlay functions; only suppress app startup.
  for(const file of ['app.js','flight-math.js','route-timeline.js','tour-display.js','atlas.js','journeys.js','research.js','sdss.js','route-player.js']){
    let source=fs.readFileSync(path.join(__dirname,'../static',file),'utf8');
    if(file==='app.js')source=source.replace(/\bboot\(\);\s*$/,'');
    vm.runInContext(source,context,{filename:file});
  }
  context.testSky=sky;context.testSurveys=ids.map(id=>({id,name:id,description:id,tag:id,url:'https://example.test/'+id}));
  const run=source=>vm.runInContext(source,context);
  run(`state.sky=testSky;state.config={surveys:testSurveys};sdssUI.config={};tourSkyChoice='2mass';
    var tourDocument={id:'saved-tour',revision:1,title:'Saved tour',kind:'waypoints',stops:[{ra:42,dec:13,fov:.2,roll:0,survey:'webb-color',projection:'AIT',travel:1,hold:30,title:'First stop',notes:''}],media:[null]};
    sdssUI.image={ra:202,dec:47,fov:.2};
    sdssUI.map={url:'/measured.png',wcs:{},ra:202,dec:47,width:34,pixel_scale_arcsec:.5,plateifu:'8485-1901',label:'Velocity',processing:'Measured velocities'};
    installTourLayerGuard(state.sky);`);
  return {run,context,element,options,chips,layers,removed,surveys,sky,events,start:()=>run('startRouteDocument(tourDocument)')};
}

for(const paused of [false,true]){
  test(`SDSS galaxy navigation leaves a ${paused?'paused':'playing'} tour and selects the requested map`,async()=>{
    const h=harness();await h.start();if(paused)h.run('pauseRoute()');
    h.run("showPage('sdss');sdssExploreImage()");
    assert.equal(h.run('state.page'),'explore');assert.equal(h.run('state.survey'),'sdss-color');
    assert.equal(h.run('tourSurveyActive()'),false);assert.equal(h.element('#route-player').hidden,true);
    assert.equal(h.run('routePlayer.playing'),false);assert.equal(h.run('routePlayer.route.id'),'saved-tour');
    assert.equal(h.run('tourSkySurvey()'),'2mass');assert.deepEqual(h.sky.getRaDec(),[202,47]);
    assert.match(h.surveys.at(-1),/\/sdss-color$/);
  });
}

test('the ordinary survey controls retain SDSS bands and do not change the tour survey preference',async()=>{
  const h=harness();await h.start();h.run('syncTourSkyControls()');
  assert.ok(h.options.every(option=>!option.disabled));assert.ok(h.chips.every(button=>!button.disabled));
  for(const survey of ['sdss-color','sdss-g','sdss-r','sdss-i','webb-color']){
    h.run(`chooseSurvey('${survey}')`);
    assert.equal(h.run('state.survey'),survey);assert.equal(h.run('tourSkySurvey()'),'2mass');
    assert.equal(h.run('tourSurveyActive()'),false);
  }
  assert.equal(h.run("setTourSkySurvey('sdss-color')"),false);
});

test('a new manual destination leaves the tour even without visiting another workspace first',async()=>{
  const h=harness();await h.start();h.run('sdssExploreImage()');
  assert.equal(h.run('state.survey'),'sdss-color');assert.equal(h.run('tourSurveyActive()'),false);
  assert.equal(h.element('#route-player').hidden,true);
});

test('returning from another workspace does not reactivate a paused tour restriction',async()=>{
  const h=harness();await h.start();h.run("showPage('sdss');showPage('explore')");
  assert.equal(h.run('tourSurveyActive()'),false);assert.equal(h.run('routePlayer.playing'),false);
  h.run("chooseSurvey('sdss-r')");assert.equal(h.run('state.survey'),'sdss-r');
});

test('tour keyboard controls cannot reclaim the map after leaving for manual SDSS exploration',async()=>{
  const h=harness();h.run('initRoutePlayer()');await h.start();h.run('sdssExploreImage()');
  const status=h.element('#route-play-status').textContent;
  for(const code of ['Space','Escape']){
    let prevented=false;
    h.events.get('keydown')({code,target:{},preventDefault(){prevented=true;}});
    assert.equal(prevented,false);assert.equal(h.run('state.survey'),'sdss-color');
    assert.equal(h.run('routePlayer.playing'),false);assert.equal(h.run('tourSurveyActive()'),false);
    assert.equal(h.element('#route-play-status').textContent,status);
  }
  h.run('resumeRoute()');
  h.events.get('keydown')({code:'Space',target:{},preventDefault(){}});
  assert.equal(h.run('routePlayer.playing'),false);assert.equal(h.run('tourSurveyActive()'),true);
});

test('a MaNGA map remains available after leaving the tour for the SDSS workspace',async()=>{
  const h=harness();await h.start();h.run("showPage('sdss');sdssOverlay()");
  assert.equal(h.run('state.survey'),'sdss-color');assert.equal(h.run('tourSurveyActive()'),false);
  assert.equal(h.layers.length,1);assert.equal(h.layers[0].layer,'sdss-manga');
  const removedBefore=h.removed.length;
  h.layers[0].settings.successCallback();
  assert.equal(h.layers[0].opacity,1);assert.equal(h.element('#sdss-remove-overlay').disabled,false);
  assert.equal(h.removed.length,removedBefore);
});

test('explicitly resuming a tour restores its survey and removes a manually opened MaNGA overlay',async()=>{
  const h=harness();await h.start();h.run("routePlayer.elapsed=12;showPage('sdss');sdssOverlay()");
  h.layers[0].settings.successCallback();assert.equal(h.layers[0].opacity,1);
  h.run('resumeRoute()');
  assert.equal(h.run('state.survey'),'2mass');assert.equal(h.run('tourSurveyActive()'),true);
  assert.equal(h.run('routePlayer.playing'),true);assert.equal(h.run('routePlayer.elapsed'),12);
  assert.equal(h.layers[0].opacity,0);assert.equal(h.run('sdssUI.overlay'),null);
  assert.equal(h.element('#route-stop-image').hidden,true);
  h.layers[0].settings.successCallback();assert.equal(h.layers[0].opacity,0);
});

test('leaving a downloaded tour releases its image and active pack but retains the pack for explicit resume',async()=>{
  const h=harness();
  h.run("var testPack={route_id:tourDocument.id,revision:1,views:[]};");
  await h.run('startRouteDocument(tourDocument,testPack)');
  h.run("atlasUI.packLayer={layer:'downloaded-tour-view'};");
  const serial=h.run('atlasUI.packRequest');
  h.run("showPage('sdss');sdssExploreImage()");
  assert.equal(h.run('atlasUI.pack'),null);assert.equal(h.run('atlasUI.packLayer'),null);
  assert.equal(h.run('routePlayer.pack===testPack'),true);assert.ok(h.run('atlasUI.packRequest')>serial);
  assert.ok(h.removed.includes('downloaded-tour-view'));assert.equal(h.run('state.survey'),'sdss-color');
  h.run('resumeRoute()');
  assert.equal(h.run('atlasUI.pack===testPack'),true);assert.equal(h.run('state.survey'),'2mass');
});
