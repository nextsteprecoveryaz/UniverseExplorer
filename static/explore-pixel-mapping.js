'use strict';

const explorePixelMapping={controller:null,stage:null,button:null};

function explorePixelSurveyInfo(id,layer){
  const survey=state.config?.surveys?.find(item=>item.id===id);
  if(survey){
    const credits={optical:'DSS2 / STScI / ESO; color HiPS by CDS','2mass':'2MASS / University of Massachusetts / IPAC-Caltech; HiPS by CDS'};
    return {id:survey.id,name:survey.name,label:survey.name,url:survey.url,source_url:survey.source_url||survey.url,
      credit:survey.credit||credits[id]||(id.startsWith('sdss-')?'SDSS Collaboration; HiPS by CDS':`${survey.name}; see the linked survey source for credits`),description:survey.description||''};
  }
  return {id,name:layer?.name||id,label:layer?.name||id,url:layer?.url||'',credit:'See the linked survey source for credits'};
}

function explorePixelLayerKey(layer){
  const url=String(layer?.url||layer?.id||'').replace(/\/$/,'');
  const survey=state.config?.surveys?.find(item=>url===item.url.replace(/\/$/,'')||url.endsWith('/api/atlas/surveys/'+encodeURIComponent(item.id)));
  if(survey)return survey.id;
  if(!url)return state.survey;
  // Custom Aladin layers get stable independent profiles without putting URLs in storage keys.
  let hash=2166136261;for(const char of url)hash=Math.imul(hash^char.charCodeAt(0),16777619);
  return 'custom-'+(hash>>>0).toString(16);
}

function initExplorePixelMapping(){
  if(explorePixelMapping.controller||!state.sky||typeof PixelMappingController==='undefined')return explorePixelMapping.controller;
  const page=$('#explore-page'),stage=document.createElement('div');stage.id='explore-map-stage';
  // Keep every existing map control and overlay in the resized map, beside the dock.
  for(const child of [...page.childNodes])stage.append(child);
  page.append(stage);explorePixelMapping.stage=stage;
  const panel=document.createElement('aside');panel.id='explore-pixel-panel';panel.hidden=true;panel.setAttribute('aria-label','Explore sky pixel mapping');page.append(panel);
  const button=document.createElement('button');button.id='explore-pixels';button.type='button';button.textContent='Pixel mapping';
  button.setAttribute('aria-controls',panel.id);button.setAttribute('aria-expanded','false');
  ($('#map-view-toolbar')||$('.mapping-control')).append(button);explorePixelMapping.button=button;
  const controller=new PixelMappingController({host:panel,sky:state.sky,storageKey:'universe:explore-pixel-mapping:v1',
    captureKind:'explore-sky-capture',captureLabel:'Explore sky',surveyInfo:explorePixelSurveyInfo,
    onResize:open=>{button.setAttribute('aria-expanded',String(open));page.classList.toggle('explore-pixels-open',open);explorePixelMapping.controller?.invalidateView();window.dispatchEvent(new Event('resize'));},
    onChange:(settings,preview)=>{const select=$('#sky-stretch');if(select)select.value=preview.original||settings.stretch==='linear'?'native':settings.stretch;}});
  explorePixelMapping.controller=controller;
  button.onclick=()=>controller.setOpen(controller.host.hidden);
  state.sky.addListener?.('AL:Layer.added',event=>{
    const layer=event.detail?.layer;
    if(layer&&layer===state.sky.getBaseImageLayer())bindExplorePixelMapping(explorePixelLayerKey(layer),layer);
  });
  bindExplorePixelMapping(state.survey,state.sky.getBaseImageLayer());
  return controller;
}

function bindExplorePixelMapping(id=state.survey,layer=state.sky?.getBaseImageLayer()){
  const controller=explorePixelMapping.controller;if(!controller)return;
  return controller.bind(id,layer);
}
function invalidateExplorePixelMapping(){explorePixelMapping.controller?.invalidateView();}
function setExplorePixelStretch(value){
  const controller=explorePixelMapping.controller;if(!controller)return false;
  const stretch=value==='native'?'linear':value;
  if(!['linear','asinh','log','sqrt','pow2'].includes(stretch))return false;
  controller.change({...controller.settings,stretch});return true;
}
