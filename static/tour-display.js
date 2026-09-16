'use strict';
const TOUR_SKY_IDS=['optical','2mass','hydrogen','dust'];
let tourSkyChoice='optical';
try{const saved=localStorage.getItem('universe-tour-sky');if(TOUR_SKY_IDS.includes(saved))tourSkyChoice=saved;}catch{}
function tourSkySurveys(){return TOUR_SKY_IDS.map(id=>state.config?.surveys?.find(s=>s.id===id)).filter(Boolean);}
function tourSkySurvey(){return tourSkySurveys().some(s=>s.id===tourSkyChoice)?tourSkyChoice:'optical';}
function tourSurveyView(view){return {...view,survey:tourSkySurvey()};}
function tourSurveyRoute(route){
  const copy=structuredClone(route);
  copy.stops=(copy.stops||[]).map(tourSurveyView);copy.track=(copy.track||[]).map(tourSurveyView);
  if(copy.progress?.origin)copy.progress.origin=tourSurveyView(copy.progress.origin);
  return copy;
}
function tourSurveyActive(){return typeof routePlayer!=='undefined'&&Boolean(routePlayer.route)&&state.page==='explore'&&!$('#route-player').hidden;}
function syncTourSkyControls(){
  const current=tourSkySurvey(),active=tourSurveyActive();
  for(const select of document.querySelectorAll('[data-tour-sky]')){
    select.innerHTML=tourSkySurveys().map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');select.value=current;
  }
  for(const option of document.querySelectorAll('#survey-select option'))option.disabled=active&&!TOUR_SKY_IDS.includes(option.value);
  for(const button of document.querySelectorAll('#lens-chips button'))button.disabled=active&&!TOUR_SKY_IDS.includes(button.dataset.survey);
}
function setTourSkySurvey(id){
  if(!tourSkySurveys().some(s=>s.id===id))return false;
  const changed=tourSkyChoice!==id;tourSkyChoice=id;
  try{localStorage.setItem('universe-tour-sky',id);}catch{}
  syncTourSkyControls();
  if(changed&&tourSurveyActive())applyRouteSkySurvey();
  return true;
}
function clearTourImageOverlays(){
  for(const id of ['selected-science-image','research-mosaic','sdss-manga'])state.sky?.removeImageLayer(id);
  if(typeof cancelTourImageOverlays==='function')cancelTourImageOverlays();
}
function installTourLayerGuard(sky){
  // Native image decoding can finish after a tour starts and after a removal call.
  // This public event fires when the decoded layer is actually added to the sky.
  sky.addListener('AL:Layer.added',event=>{
    if(!tourSurveyActive())return;
    const layer=event.detail?.layer,key=layer?.layer;
    if(!key||layer===sky.getBaseImageLayer())return;
    if(key==='downloaded-tour-view'&&atlasUI.packLayer===layer)return;
    sky.removeImageLayer(key);
  });
}
function initTourSkyControls(){
  syncTourSkyControls();
  for(const select of document.querySelectorAll('[data-tour-sky]'))select.onchange=()=>setTourSkySurvey(select.value);
}
