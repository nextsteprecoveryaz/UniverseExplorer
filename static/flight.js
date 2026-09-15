'use strict';
const flight={active:false,keys:new Set(),taps:new Map(),velocity:[0,0,0,0],cruise:false,frame:null,last:0,painted:0,camera:null,writing:false,projection:'AIT',quiet:true};
const FLIGHT_KEYS={ArrowLeft:[-1,0,0,0],KeyA:[-1,0,0,0],ArrowRight:[1,0,0,0],KeyD:[1,0,0,0],ArrowUp:[0,1,0,0],ArrowDown:[0,-1,0,0],KeyW:[0,0,1,0],KeyS:[0,0,-1,0],KeyQ:[0,0,0,-1],KeyE:[0,0,0,1]};
function flightEditable(target){return target?.closest('input,textarea,select,[contenteditable="true"]');}
function flightPose(){if(state.sky)flight.camera=FlightMath.basis(...state.sky.getRaDec(),state.sky.getRotation());}
function flightViewChanged(){
  if(!flight.active||flight.writing)return;
  const fov=state.sky.getFov()[0],limited=FlightMath.clamp(fov,.001,110);
  if(fov!==limited){flight.writing=true;try{state.sky.setFoV(limited);}finally{flight.writing=false;}}
  flightPose();
}
function flightStatus(text){$('#flight-status').textContent=text;}
function pauseFlight(text='Stopped · steer to continue'){
  if(typeof disarmGamepad==='function')disarmGamepad();
  flight.keys.clear();flight.taps.clear();flight.velocity=[0,0,0,0];flight.cruise=false;
  cancelAnimationFrame(flight.frame);flight.frame=null;flight.last=0;
  $('#flight-cruise').setAttribute('aria-pressed','false');$('#flight-cruise').textContent='▷ Cruise';
  if(flight.active){flightStatus(text);coordinates();}
}
function setFlightQuiet(quiet){
  flight.quiet=quiet;$('#explore-page').classList.toggle('flight-quiet',flight.active&&quiet);
  $('#flight-panels').setAttribute('aria-pressed',String(!quiet));$('#flight-panels').textContent=quiet?'Show panels':'Hide panels';
}
function exitFlight(){
  if(!flight.active)return;
  pauseFlight();flight.active=false;$('#explore-page').classList.remove('flight-active','flight-quiet');
  $('#flight-panel').hidden=true;$('#flight-reticle').hidden=true;$('#flight-toggle').setAttribute('aria-pressed','false');$('#flight-toggle').textContent='✧ Fly';
  state.sky.setProjection(flight.projection);state.sky.setRotation(0);coordinates();
}
function startFlight(){
  if(typeof pauseRouteForFlight==='function')pauseRouteForFlight();
  if(!state.sky){toast('Connect to the sky map before starting flight.',true);return;}
  cancelAnimationFrame(travelFrame);flight.projection=state.sky.getProjectionName()||'AIT';
  flight.active=true;flight.writing=true;
  try{state.sky.setProjection('TAN');state.sky.setFoV(FlightMath.clamp(state.sky.getFov()[0],.001,70));state.sky.setRotation(0);}finally{flight.writing=false;}
  flightPose();$('#explore-page').classList.add('flight-active');$('#flight-panel').hidden=false;$('#flight-reticle').hidden=false;
  $('#flight-toggle').setAttribute('aria-pressed','true');$('#flight-toggle').textContent='✧ Exit flight';setFlightQuiet(flight.quiet);
  stopObjectVideo();flightStatus('Ready · arrows steer · W / S zoom');$('#flight-stop').focus({preventScroll:true});coordinates();
}
function wakeFlight(){
  if(!flight.active||flight.frame!==null)return;
  flight.last=performance.now();flight.frame=requestAnimationFrame(tickFlight);
}
function tickFlight(now){
  flight.frame=null;
  if(!flight.active||state.page!=='explore'||document.hidden||$('#modal').open){pauseFlight('Paused · steer to continue');return;}
  const dt=Math.min(.05,Math.max(0,(now-flight.last)/1000));flight.last=now;
  const input=[flight.cruise?.22:0,0,0,0];
  if(typeof gamepadFlight!=='undefined'&&gamepadFlight.enabled)gamepadFlight.input.forEach((v,i)=>input[i]+=v);
  for(const [key,until] of flight.taps)if(until<now)flight.taps.delete(key);
  const pressed=new Set([...flight.keys,...flight.taps.keys()]);
  for(const key of pressed){const direction=FLIGHT_KEYS[key];if(direction)direction.forEach((v,i)=>input[i]+=v);}
  const boost=flight.keys.has('ShiftLeft')||flight.keys.has('ShiftRight')?3:1;
  const pace=Number($('#flight-speed').value)*boost;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const alpha=reduced?1:1-Math.exp(-dt*12);
  flight.velocity=flight.velocity.map((v,i)=>v+(FlightMath.clamp(input[i],-1,1)*pace-v)*alpha);
  if(flight.velocity.every(v=>Math.abs(v)<.001)&&input.every(v=>v===0)){flight.velocity=[0,0,0,0];flightStatus('Stopped · steer to continue');coordinates();return;}
  const fov=state.sky.getFov()[0],rate=Math.max(.0002,fov)*.5;
  flight.camera=FlightMath.turn(flight.camera,flight.velocity[0]*rate*dt,flight.velocity[1]*rate*dt,flight.velocity[3]*35*dt);
  const p=FlightMath.orientation(flight.camera),nextFov=FlightMath.zoom(fov,flight.velocity[2]*.85,dt);
  flight.writing=true;
  try{
    state.sky.gotoRaDec(p.ra,p.dec);state.sky.setRotation(p.roll);
    if(Math.abs(nextFov-fov)>1e-10)state.sky.setFoV(nextFov);
  }catch(error){pauseFlight('Flight stopped');failure(error);return;}finally{flight.writing=false;}
  if(now-flight.painted>160){
    flight.painted=now;
    const activity=Math.abs(flight.velocity[2])>.02?(flight.velocity[2]>0?'Moving closer':'Pulling back'):flight.cruise?'Cruising':'Steering';
    flightStatus(`${activity} · ${nextFov<.01?nextFov.toFixed(5):nextFov.toFixed(2)}° field${boost>1?' · boost':''}`);
  }
  flight.frame=requestAnimationFrame(tickFlight);
}
function animateSkyTravel(from,to){
  const targetFov=to.fov||.2;
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){state.sky.gotoRaDec(to.ra,to.dec);state.sky.setFoV(targetFov);return;}
  const distance=FlightMath.separation(from,to),duration=FlightMath.clamp(900+distance*15,900,3300),start=performance.now();
  const peak=Math.max(from.fov,targetFov,Math.min(110,distance*1.3));
  const ease=x=>x*x*(3-2*x),blend=(a,b,t)=>Math.exp(Math.log(Math.max(.001,a))*(1-t)+Math.log(Math.max(.001,b))*t);
  const tick=now=>{
    const t=Math.min(1,(now-start)/duration),p=FlightMath.interpolate(from,to,ease(t));
    const fov=t<.4?blend(from.fov,peak,ease(t/.4)):blend(peak,targetFov,ease((t-.4)/.6));
    state.sky.gotoRaDec(p.ra,p.dec);state.sky.setFoV(fov);
    if(t<1)travelFrame=requestAnimationFrame(tick);
  };
  travelFrame=requestAnimationFrame(tick);
}
function initFlight(){
  $('#flight-toggle').onclick=()=>flight.active?exitFlight():startFlight();
  $('#flight-exit').onclick=exitFlight;$('#flight-stop').onclick=()=>pauseFlight();
  $('#flight-panels').onclick=()=>setFlightQuiet(!flight.quiet);
  $('#flight-cruise').onclick=()=>{
    flight.cruise=!flight.cruise;$('#flight-cruise').setAttribute('aria-pressed',String(flight.cruise));$('#flight-cruise').textContent=flight.cruise?'Ⅱ Pause cruise':'▷ Cruise';wakeFlight();
  };
  $('#flight-level').onclick=()=>{pauseFlight();state.sky.setRotation(0);flightPose();};
  $('#flight-save').onclick=()=>{pauseFlight();noteDialog({title:'Flight waypoint',provenance:{...currentField(),mode:'angular sky flight'}});};
  $('#flight-images').onclick=()=>{
    pauseFlight();journeys.near=currentImageRegion();journeys.recentPage=1;journeys.tab='recent';$('#recent-field').checked=true;
    showPage('journeys');selectJourneyTab('recent');
  };
  const inputAllowed=()=>flight.active&&state.page==='explore'&&!$('#modal').open;
  document.addEventListener('keydown',e=>{
    if(!inputAllowed()||e.ctrlKey||e.altKey||e.metaKey)return;
    if(e.code==='Escape'){pauseFlight();return;}
    if(flightEditable(e.target))return;
    if(e.code==='Space'){e.preventDefault();pauseFlight();return;}
    if(!FLIGHT_KEYS[e.code]&&!e.code.startsWith('Shift'))return;
    e.preventDefault();cancelAnimationFrame(travelFrame);flight.keys.add(e.code);wakeFlight();
  });
  document.addEventListener('keyup',e=>{flight.keys.delete(e.code);});
  $$('[data-flight-key]').forEach(button=>{
    let down=0;
    button.onpointerdown=e=>{if(e.button!==0)return;down=performance.now();button.setPointerCapture(e.pointerId);flight.keys.add(button.dataset.flightKey);wakeFlight();};
    const release=()=>{flight.keys.delete(button.dataset.flightKey);};
    button.onpointerup=release;button.onpointercancel=release;button.onlostpointercapture=release;
    button.onclick=()=>{if(performance.now()-down<180||down===0){flight.taps.set(button.dataset.flightKey,performance.now()+220);wakeFlight();}down=0;};
  });
  const sky=$('#aladin-lite-div');
  sky.addEventListener('pointerdown',()=>{if(flight.active)pauseFlight();});
  sky.addEventListener('wheel',()=>{if(flight.active)pauseFlight();},{passive:true});
  sky.addEventListener('pointerup',()=>{if(flight.active)flightPose();});
  document.addEventListener('focusin',e=>{if(flight.active&&flightEditable(e.target))pauseFlight();});
  window.addEventListener('blur',()=>{if(flight.active)pauseFlight('Paused · window lost focus');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&flight.active)pauseFlight('Paused · steer to continue');});
  new MutationObserver(()=>{if($('#modal').open&&flight.active)pauseFlight('Paused · viewing an object');}).observe($('#modal'),{attributes:true,attributeFilter:['open']});
}
