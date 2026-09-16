'use strict';
const routePlayer={route:null,pack:null,timeline:null,elapsed:0,playing:false,frame:null,last:0,index:-1,writing:false,projection:null,survey:null,waitSince:0,waitKey:'',skipWait:false,lastProgress:0,prefetch:[],drawn:0};
const routeRecorder={route:null,active:false,paused:false,last:0,elapsed:0,saving:null,pending:false,lastSaved:0,error:null};
let routeProgressQueue=Promise.resolve(),recordingStarting=false;
function skyView(){
  const p=currentField();return {...p,roll:state.sky?.getRotation()||0,projection:state.sky?.getProjectionName()||'AIT'};
}
function routeTime(seconds){return Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');}
function interruptTour(reason='Paused for manual exploration'){
  if(routePlayer.writing||!routePlayer.playing)return;
  pauseRoute(reason);
}
function leaveTourView(reason='Paused · manual exploration'){
  if(!routePlayer.route||routePlayer.writing||$('#route-player').hidden)return;
  pauseRoute(reason);
  atlasStopPack();
  $('#route-player').hidden=true;$('#explore-page').classList.remove('route-active');
  if(navigationUI.footprint){state.sky?.removeOverlay(navigationUI.footprint);navigationUI.footprint=null;}
  setNearbyVisible(navigationUI.nearbyPreference);
  if(typeof atlasMessage==='function')atlasMessage('');
  syncTourSkyControls();
}
function pauseRouteForFlight(){leaveTourView();}
function pauseRoute(reason='Paused'){
  routePlayer.playing=false;cancelAnimationFrame(routePlayer.frame);routePlayer.frame=null;
  if(typeof pauseTourNarration==='function')pauseTourNarration();else if(window.speechSynthesis)window.speechSynthesis.cancel();
  $('#route-play-toggle').textContent='▶ Resume';$('#route-play-status').textContent=reason;
  if(routePlayer.route)saveRouteProgress();
}
async function saveRouteProgress(){
  const p=routePlayer;if(!p.route?.id||!p.timeline||p.pack||atlasUI.pack)return;
  const id=p.route.id,body=JSON.stringify({revision:p.route.revision,elapsed:p.elapsed,origin:p.timeline.origin});
  routeProgressQueue=routeProgressQueue.then(()=>api('/api/navigation/routes/'+id+'/progress',{method:'PUT',headers:{'Content-Type':'application/json'},body})).catch(()=>{if(p.route?.id===id)$('#route-play-status').textContent+=' · progress could not be saved';});
  return routeProgressQueue;
}
function closeRoutePlayer(){
  atlasStopPack();
  if(typeof resetTourNarration==='function')resetTourNarration();
  pauseRoute();routePlayer.route=null;routePlayer.pack=null;routePlayer.timeline=null;$('#route-player').hidden=true;
  $('#explore-page').classList.remove('route-active');if(navigationUI.footprint){state.sky?.removeOverlay(navigationUI.footprint);navigationUI.footprint=null;}
  setNearbyVisible(navigationUI.nearbyPreference);
  syncTourSkyControls();
}
async function playSavedRoute(id,resume=false){
  if(routeRecorder.active){toast('Stop and save the recording before playing a route.',true);return;}
  const route=await api('/api/navigation/routes/'+id);
  return startRouteDocument(route,null,resume);
}
async function startRouteDocument(route,pack=null,resume=false){
  if(routeRecorder.active){toast('Stop and save the recording before playing a route.',true);return;}
  atlasStopPack();
  atlasClear();clearTourImageOverlays();route=tourSurveyRoute(route);
  if(pack){atlasUI.pack=pack;atlasClear();}
  if(route.kind==='recording'?route.track.length<2:!route.stops.length){toast('Add at least one waypoint, or record at least two samples.',true);return;}
  pauseRoute();if(flight.active)exitFlight();showPage('explore');setNearbyVisible(false);
  const progress=resume?route.progress:null;
  const origin=tourSurveyView(progress?.origin||skyView());
  Object.assign(routePlayer,{route,pack,timeline:RouteTimeline.build(route,origin),elapsed:progress?.elapsed||0,index:-1,waitKey:'',waitSince:0,skipWait:false,projection:null,survey:null});
  $('#route-player').hidden=false;$('#explore-page').classList.add('route-active');$('#route-playing-title').textContent=route.title;
  syncTourSkyControls();
  $('#route-play-seek').max=routePlayer.timeline.total;$('#route-play-seek').value=routePlayer.elapsed;
  $('#route-play-prev').disabled=route.kind==='recording';$('#route-play-next').disabled=route.kind==='recording';
  applyRouteFrame(RouteTimeline.at(routePlayer.timeline,routePlayer.elapsed));resumeRoute();
}
function resumeRoute(){
  if(!routePlayer.route||!state.sky)return;
  if(state.page!=='explore')showPage('explore');if(flight.active)exitFlight();
  atlasClear();clearTourImageOverlays();
  if(routePlayer.pack)atlasUI.pack=routePlayer.pack;
  if(routePlayer.elapsed>=routePlayer.timeline.total)routePlayer.elapsed=0;
  routePlayer.playing=true;routePlayer.last=performance.now();routePlayer.waitSince=0;routePlayer.waitKey='';
  routePlayer.projection=null;routePlayer.survey=null;
  routePlayer.lastView=null;
  $('#route-player').hidden=false;$('#explore-page').classList.add('route-active');setNearbyVisible(false);
  syncTourSkyControls();
  applyRouteFrame(RouteTimeline.at(routePlayer.timeline,routePlayer.elapsed));
  if(routePlayer.route.kind==='waypoints'&&routePlayer.index>=0)atlasShowPackView(routePlayer.route,routePlayer.index);
  $('#route-play-toggle').textContent='Ⅱ Pause';cancelAnimationFrame(routePlayer.frame);routePlayer.frame=requestAnimationFrame(tickRoute);
  if(typeof resumeTourNarration==='function')resumeTourNarration();
}
function narrationFor(media,stop){return (media?.narration?.trim()||[stop?.title,media?.description||stop?.notes||''].filter(Boolean).join('. ')).replace(/\s+/g,' ').trim().slice(0,3500);}
function speakRouteStop(){
  if(typeof startTourNarration==='function'){void startTourNarration();return;}
  if(!$('#route-narration').checked||!window.speechSynthesis||!routePlayer.playing)return;
  window.speechSynthesis.cancel();const i=routePlayer.index,utterance=new SpeechSynthesisUtterance(narrationFor(routePlayer.route.media[i],routePlayer.route.stops[i]));
  utterance.rate=Math.min(1.6,Number($('#route-play-speed').value));window.speechSynthesis.speak(utterance);
}
function updateRouteGuide(index){
  if(typeof resetTourNarration==='function')resetTourNarration();
  const p=routePlayer;p.index=index;p.waitSince=0;p.skipWait=false;
  $('#route-story-sources').innerHTML=storySourcesMarkup(p.route.kind==='recording'?null:p.route.media[index]);
  if(p.route.kind==='recording'){
    $('#route-stop-title').textContent='Your recorded flight';$('#route-stop-description').textContent=p.route.description||'Replay of sampled sky positions, zoom and rotation in your selected full-sky survey.';
    $('#route-stop-facts').textContent='';$('#route-image-message').textContent='';
    $('#route-stop-image').hidden=true;$('#route-stop-source').hidden=true;$('#route-stop-credit').textContent='Recorded camera path · interpolated between samples';$('#route-stop-actions').hidden=true;return;
  }
  const stop=p.route.stops[index],media=p.route.media[index];
  atlasPrefetch(p.route,index);
  atlasShowPackView(p.route,index);
  $('#route-stop-title').textContent=stop.title;$('#route-stop-description').textContent=[media?.description,stop.notes?'Your notes: '+stop.notes:''].filter(Boolean).join('\n\n')||'Saved sky waypoint.';
  const facts=[`Sky position: RA ${stop.ra.toFixed(5)}°, Dec ${stop.dec.toFixed(5)}° · field ${stop.fov.toFixed(4)}°`,state.config.surveys.find(s=>s.id===tourSkySurvey())?.name||tourSkySurvey()];
  if(media?.observed_at)facts.push('Source exposure: '+media.observed_at.replace('T',' ').replace(/Z$/,'')+' UTC');
  if(media?.filters)facts.push('Source filter: '+media.filters);
  if(Number.isFinite(media?.ra)&&FlightMath.separation(stop,media)>.001)facts.push('Waypoint edited: its center differs from the linked source position.');
  $('#route-stop-facts').textContent=facts.join('\n');
  const img=$('#route-stop-image');img.hidden=true;img.dataset.loaded='none';img.onload=null;img.onerror=null;img.removeAttribute('src');
  $('#route-image-message').textContent=media?.available===false?'Story source unavailable in the current index.':'';
  const link=$('#route-stop-source');link.hidden=!media?.source_url;if(media?.source_url)link.href=media.source_url;
  $('#route-stop-credit').textContent=media?[media.location_note,media.credit].filter(Boolean).join(' '):'User-saved sky position.';
  $('#route-stop-actions').hidden=false;$('#route-stop-inspect').disabled=!media?.available;
  $('#route-stop-inspect').textContent='About this stop';
  link.textContent=media?.kind==='cefca'?'Original CEFCA guide · Spanish ↗':'Publisher source & credits ↗';
  $('#route-stop-video').hidden=true;
  drawNavigationFootprint(media?.footprint);
  p.prefetch=[];
  if(window.speechSynthesis)window.speechSynthesis.cancel();
  saveRouteProgress();
}
function applyRouteFrame(frame){
  if(!frame)return;
  const p=routePlayer,v=tourSurveyView(frame.view);p.writing=true;
  try{
    if(p.projection!==v.projection){state.sky.setProjection(v.projection);p.projection=v.projection;}
    if(p.survey!==v.survey){chooseSurvey(v.survey);p.survey=v.survey;}
    const previous=p.lastView;
    if(!previous||previous.ra!==v.ra||previous.dec!==v.dec)state.sky.gotoRaDec(v.ra,v.dec);
    if(!previous||previous.fov!==v.fov)state.sky.setFoV(v.fov);
    if(!previous||previous.roll!==v.roll)state.sky.setRotation(v.roll||0);
    p.lastView={...v};
    if(p.route.kind==='recording'){if(p.index<0)updateRouteGuide(0);}else if(p.index!==frame.index)updateRouteGuide(frame.index);
  }finally{p.writing=false;}
  const status=p.route.kind==='recording'?'Recorded flight':`Stop ${frame.index+1} / ${p.route.stops.length} · ${frame.phase==='travel'?'gliding to target':'exploring'}`;
  $('#route-play-status').textContent=status;$('#route-play-time').textContent=routeTime(p.elapsed)+' / '+routeTime(p.timeline.total);$('#route-play-seek').value=p.elapsed;
  $('#route-play-progress').style.width=(p.timeline.total?100*p.elapsed/p.timeline.total:0)+'%';
}
function tickRoute(now){
  const p=routePlayer;p.frame=null;if(!p.playing)return;
  if(document.hidden||state.page!=='explore'||$('#modal').open){pauseRoute('Paused · resume when ready');return;}
  const dt=Math.min(.1,(now-p.last)/1000)*Number($('#route-play-speed').value);p.last=now;
  const frame=RouteTimeline.at(p.timeline,p.elapsed);
  if(frame.phase==='hold'&&!p.skipWait){
    const key='stop-'+frame.index;
    if(p.waitKey!==key){p.waitKey=key;p.waitSince=now;speakRouteStop();}
    const pending=state.sky.isStillActive?.();
    if(pending&&now-p.waitSince<10000){$('#route-play-status').textContent='Loading survey tiles before continuing…';p.frame=requestAnimationFrame(tickRoute);return;}
    if(pending){pauseRoute('Image tiles are still loading · Resume to retry or choose Next');return;}
  }
  const segment=p.timeline.segments[frame.index];
  if(frame.phase==='hold'&&segment&&typeof tourNarrationPending==='function'&&tourNarrationPending()&&p.elapsed+dt>=segment.end){$('#route-play-status').textContent='Listening to narration before the next stop…';p.frame=requestAnimationFrame(tickRoute);return;}
  p.elapsed=Math.min(p.timeline.total,p.elapsed+dt);applyRouteFrame(RouteTimeline.at(p.timeline,p.elapsed));
  if(p.elapsed>=p.timeline.total){pauseRoute('Journey complete · replay or take the controls');return;}
  p.frame=requestAnimationFrame(tickRoute);
}
function seekRoute(time){
  if(!routePlayer.timeline)return;pauseRoute();routePlayer.elapsed=Math.min(routePlayer.timeline.total,Math.max(0,time));
  const frame=RouteTimeline.at(routePlayer.timeline,routePlayer.elapsed);
  routePlayer.waitKey='';applyRouteFrame(frame);pauseRoute(frame?.phase==='travel'?'Paused during travel to '+routePlayer.route.stops[frame.index].title:'Paused at selected position');
}
function applyRouteSkySurvey(){
  const p=routePlayer;if(!p.route||!p.timeline)return;
  p.route.stops=(p.route.stops||[]).map(tourSurveyView);p.route.track=(p.route.track||[]).map(tourSurveyView);
  p.timeline=RouteTimeline.build(p.route,tourSurveyView(p.timeline.origin));p.survey=null;p.lastView=null;
  atlasClear();clearTourImageOverlays();atlasUI.packIndex=-1;
  applyRouteFrame(RouteTimeline.at(p.timeline,p.elapsed));
  if(p.route.kind!=='recording'){
    const stop=p.route.stops[p.index];
    $('#route-stop-facts').textContent=`Sky position: RA ${stop.ra.toFixed(5)}°, Dec ${stop.dec.toFixed(5)}° · field ${stop.fov.toFixed(4)}°\n${state.config.surveys.find(s=>s.id===tourSkySurvey())?.name||tourSkySurvey()}`;
    atlasShowPackView(p.route,p.index);atlasPrefetch(p.route,p.index);
  }
}
function skipRouteStop(direction){
  const p=routePlayer;if(!p.timeline?.segments.length)return;
  const index=FlightMath.clamp(p.index+direction,0,p.timeline.segments.length-1),playing=p.playing;
  seekRoute(playing?p.timeline.segments[index].start:p.timeline.segments[index].arrive);if(playing)resumeRoute();
}
function trackSnapshot(){return {...skyView(),t:Number(routeRecorder.elapsed.toFixed(3))};}
async function beginRecording(){
  if(routeRecorder.active||recordingStarting)return;
  recordingStarting=true;
  try{
  if(navigationUI.dirty)await saveEditedRoute();
  closeRoutePlayer();showPage('explore');if(!flight.active)startFlight();
  const title='Flight · '+new Date().toLocaleString();
  const route=await jsonPost('/api/navigation/routes',{title,description:'Recorded from the real sky explorer. Camera samples are taken twice per second.',kind:'recording',stops:[],track:[{...skyView(),t:0}]});
  Object.assign(routeRecorder,{route,active:true,paused:false,last:performance.now(),elapsed:0,lastSaved:0,error:null});
  $('#recording-chip').hidden=false;$('#recording-toggle').textContent='Ⅱ';recordingLabel();
  }finally{recordingStarting=false;}
}
function recordingLabel(){
  const r=routeRecorder;if(!r.route)return;
  $('#recording-status').textContent=(r.error?'Save failed · ':r.paused?'Paused · ':'● Recording · ')+routeTime(r.elapsed)+' · '+r.route.track.length+' samples';
}
function recordTick(){
  const r=routeRecorder,now=performance.now(),dt=(now-r.last)/1000;r.last=now;
  if(!r.active||r.paused||document.hidden||!document.hasFocus()||state.page!=='explore'||$('#modal').open)return;
  r.elapsed+=dt;
  if(r.elapsed>=1800||r.route.track.length>=3600){finishRecording().catch(failure);return;}
  const sample=trackSnapshot();if(sample.t>r.route.track.at(-1).t)r.route.track.push(sample);
  recordingLabel();
  if(r.elapsed-r.lastSaved>=5){r.lastSaved=r.elapsed;saveRecording().catch(()=>{});}
}
async function saveRecording(){
  const r=routeRecorder;if(!r.route)return;
  if(r.saving){r.pending=true;return r.saving;}
  r.saving=(async()=>{
    try{
      do{
        r.pending=false;const snapshot=JSON.parse(JSON.stringify(routePayload(r.route))),revision=r.route.revision,id=r.route.id;
        const saved=await api('/api/navigation/routes/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...snapshot,revision})});
        r.route.revision=saved.revision;r.route.updated_at=saved.updated_at;r.error=null;
      }while(r.pending);
    }
    catch(e){r.error=e.message;recordingLabel();throw e;}
    finally{r.saving=null;}
  })();
  await r.saving;
  if(r.pending){r.pending=false;await saveRecording();}
}
async function finishRecording(){
  const r=routeRecorder;if(!r.route)return;r.active=false;r.paused=true;pauseFlight();
  try{await saveRecording();$('#recording-chip').hidden=true;toast('Flight saved · '+r.route.track.length+' camera samples.');await loadSavedRoutes();await editSavedRoute(r.route.id);showPage('routes');}
  catch(e){$('#recording-chip').hidden=false;$('#recording-status').textContent='Recording retained in memory · save failed';toast(e.message,true);}
}
function initRoutePlayer(){
  $('#route-play-toggle').onclick=()=>routePlayer.playing?pauseRoute():resumeRoute();
  $('#route-play-close').onclick=closeRoutePlayer;
  $('#route-play-prev').onclick=()=>skipRouteStop(-1);$('#route-play-next').onclick=()=>skipRouteStop(1);
  $('#route-play-seek').oninput=e=>seekRoute(Number(e.target.value));
  $('#route-play-manual').onclick=()=>{leaveTourView('Paused · you have the flight controls');startFlight();};
  $('#route-stop-inspect').onclick=()=>showTourStopDetails(routePlayer.route.media[routePlayer.index]);
  $('#route-stop-video').onclick=()=>{pauseRoute();const m=routePlayer.route.media[routePlayer.index];modal(m.video_title,`<video controls playsinline style="width:100%" src="${esc(m.video_url)}"></video><p>${esc(m.video_kind)}</p><a href="${esc(m.video_page)}" target="_blank" rel="noopener">Publisher credits ↗</a>`);};
  $('#route-narration').onchange=()=>{if($('#route-narration').checked)speakRouteStop();else window.speechSynthesis?.cancel();};
  if(typeof initTourNarration==='function')initTourNarration();else if(!window.speechSynthesis)$('#route-narration').disabled=true;
  $('#record-flight').onclick=()=>beginRecording().catch(failure);$('#flight-record').onclick=()=>beginRecording().catch(failure);
  $('#recording-toggle').onclick=()=>{routeRecorder.paused=!routeRecorder.paused;routeRecorder.last=performance.now();$('#recording-toggle').textContent=routeRecorder.paused?'▶':'Ⅱ';recordingLabel();};
  $('#recording-stop').onclick=()=>finishRecording().catch(failure);setInterval(recordTick,500);
  document.addEventListener('keydown',e=>{if(!tourSurveyActive()||flight.active||$('#modal').open||flightEditable(e.target))return;if(e.code==='Space'){e.preventDefault();routePlayer.playing?pauseRoute():resumeRoute();}if(e.code==='Escape')pauseRoute();});
  const interrupt=()=>interruptTour();$('#aladin-lite-div').addEventListener('pointerdown',interrupt);$('#aladin-lite-div').addEventListener('wheel',interrupt,{passive:true});
  for(const id of ['#zoom-in','#zoom-out'])$(id).addEventListener('click',interrupt);
  window.addEventListener('blur',()=>interruptTour('Paused · window lost focus'));
  document.addEventListener('visibilitychange',()=>{routeRecorder.last=performance.now();if(document.hidden){interruptTour('Paused · tab hidden');if(routeRecorder.active)saveRecording().catch(()=>{});}});
  window.addEventListener('beforeunload',e=>{if(routeRecorder.active||routeRecorder.error||navigationUI.dirty){e.preventDefault();e.returnValue='';}});
}
