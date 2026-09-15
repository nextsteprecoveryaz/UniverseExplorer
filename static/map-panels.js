'use strict';

// Presentation preferences are separate from catalog layers, playback and feature visibility.
const MAP_PANEL_IDS=['sidebar','mapping','image-controls','image-index','objects','live','nearby','route','flight','intro','destinations'];
const MAP_PANEL_KEY='universe-map-panels-v1';
function readMapLayout(value){
  const clean=list=>Array.isArray(list)?[...new Set(list.filter(id=>MAP_PANEL_IDS.includes(id)))]:[];
  return {minimized:clean(value?.minimized),beforeClear:Array.isArray(value?.beforeClear)?clean(value.beforeClear):null};
}
function changeMapPanel(layout,id,minimized){
  const next=readMapLayout(layout);
  if(MAP_PANEL_IDS.includes(id))next.minimized=minimized?[...new Set([...next.minimized,id])]:next.minimized.filter(v=>v!==id);
  return next;
}
function toggleClearMap(layout){
  const next=readMapLayout(layout);
  return next.beforeClear===null?{minimized:[...MAP_PANEL_IDS],beforeClear:[...next.minimized]}:{minimized:[...next.beforeClear],beforeClear:null};
}
const mapPanelUI={layout:readMapLayout(null),panels:[],ready:false};
function saveMapLayout(){try{localStorage.setItem(MAP_PANEL_KEY,JSON.stringify(mapPanelUI.layout));}catch{/* Controls still work if browser storage is unavailable. */}}
function mapPanelHidden(id){return mapPanelUI.layout.minimized.includes(id);}
function setMapPanel(id,minimized){
  mapPanelUI.layout=changeMapPanel(mapPanelUI.layout,id,minimized);
  if(minimized&&id==='objects')stopObjectVideo();
  saveMapLayout();applyMapLayout();
}
function toggleMapClearView(){
  mapPanelUI.layout=toggleClearMap(mapPanelUI.layout);
  if(mapPanelUI.layout.beforeClear!==null)stopObjectVideo();
  saveMapLayout();applyMapLayout();closeMapPanelMenu();
  $('#map-clear-view').focus({preventScroll:true});
}
function closeMapPanelMenu(){
  $('#map-panel-menu').hidden=true;$('#map-panels-toggle').setAttribute('aria-expanded','false');
}
function openMapPanelMenu(){
  syncMapPanelControls();$('#map-panel-menu').hidden=false;$('#map-panels-toggle').setAttribute('aria-expanded','true');
  $('#map-panel-menu-close').focus({preventScroll:true});
}
function applyMapLayout(){
  const page=$('#explore-page');
  const sidebarChanged=document.body.classList.contains('map-sidebar-minimized')!==mapPanelHidden('sidebar');
  for(const panel of mapPanelUI.panels)panel.element.classList.toggle('map-panel-minimized',mapPanelHidden(panel.id));
  document.body.classList.toggle('map-sidebar-minimized',mapPanelHidden('sidebar'));
  page.classList.toggle('map-clear-view',mapPanelUI.layout.beforeClear!==null);
  // Resizing the canvas must preserve the current coordinates and zoom.
  if(sidebarChanged)window.dispatchEvent(new Event('resize'));
  syncMapPanelControls();
  const focused=document.activeElement;
  if(mapPanelUI.panels.some(p=>mapPanelHidden(p.id)&&p.element.contains(focused)))$('#map-panels-toggle').focus({preventScroll:true});
}
function syncMapPanelControls(){
  const clear=mapPanelUI.layout.beforeClear!==null;
  $('#map-clear-view').textContent=clear?'Restore layout':'Clear view';
  $('#map-clear-view').setAttribute('aria-pressed',String(clear));
  $('#map-sidebar-toggle').textContent=mapPanelHidden('sidebar')?'Show sidebar':'Hide sidebar';
  $('#map-sidebar-toggle').setAttribute('aria-expanded',String(!mapPanelHidden('sidebar')));
  const count=mapPanelUI.layout.minimized.length;
  $('#map-panels-toggle').textContent=count?`Panels · ${count} hidden`:'Panels';
  for(const panel of mapPanelUI.panels){
    const inert=mapPanelHidden(panel.id)&&(panel.id!=='sidebar'||$('#explore-page').classList.contains('active'));
    if(panel.element.inert!==inert)panel.element.inert=inert;
    // Minimized overlays retain their native display value. Feature-owned [hidden]
    // and mode-specific CSS remain authoritative, even after restoring a layout.
    const available=panel.id==='sidebar'||getComputedStyle(panel.element).display!=='none';
    panel.input.checked=!mapPanelHidden(panel.id);panel.input.disabled=!available;
    panel.note.textContent=available?(mapPanelHidden(panel.id)?'Minimized':'Shown'):panel.unavailable;
  }
  const visible=id=>{const p=mapPanelUI.panels.find(p=>p.id===id);return p&&!mapPanelHidden(id)&&getComputedStyle(p.element).display!=='none';};
  $('#explore-page').classList.toggle('map-right-clear',!['objects','live','nearby','route'].some(visible));
  const flightMini=!$('#flight-panel').hidden&&mapPanelHidden('flight');
  const routeMini=!$('#route-player').hidden&&mapPanelHidden('route');
  $('#map-flight-mini').hidden=!flightMini;$('#map-route-mini').hidden=!routeMini;
  $('#explore-page').classList.toggle('map-compact-flight',flightMini);
  $('#explore-page').classList.toggle('map-compact-route',routeMini);
  $('#map-route-title').textContent=$('#route-stop-title').textContent||'Guided journey';
  $('#map-route-pause').textContent=$('#route-play-toggle').textContent;
}
function initMapPanels(){
  try{mapPanelUI.layout=readMapLayout(JSON.parse(localStorage.getItem(MAP_PANEL_KEY)));}catch{}
  const page=$('#explore-page'),toolbar=document.createElement('div');
  toolbar.id='map-view-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','Map layout');
  toolbar.innerHTML='<button id="map-sidebar-toggle" type="button" aria-controls="map-sidebar">Hide sidebar</button><button id="map-panels-toggle" type="button" aria-expanded="false" aria-controls="map-panel-menu">Panels</button><button id="map-clear-view" type="button" aria-pressed="false" title="Hide map panels and sidebar (H)">Clear view</button>';
  page.append(toolbar);
  const menu=document.createElement('section');menu.id='map-panel-menu';menu.hidden=true;menu.setAttribute('aria-label','Map panels');
  menu.innerHTML='<div class="map-menu-heading"><strong>Map panels</strong><button id="map-panel-menu-close" type="button" aria-label="Close panel menu">×</button></div><p>Choose what stays on the map. <kbd>H</kbd> toggles clear view.</p><div id="map-panel-options"></div><p class="map-menu-footnote">Image layers and object markers stay on the map. Inactive panels become available when their feature is open.</p><button id="map-panel-reset" type="button">Reset panel layout</button>';
  page.append(menu);
  const definitions=[
    ['sidebar','.sidebar','Sidebar & lenses',null,''],
    ['mapping','.mapping-control','Map switches',null,''],
    ['image-controls','.image-map-control','Image location controls',null,''],
    ['image-index','#image-index-card','Image collection status','.image-map-legend','Available with image locations, outside a tour or quiet flight'],
    ['objects','#object-panel','Object information','.object-panel-top','Open Object map; close nearby suggestions or the tour'],
    ['live','#live-panel','Telescope Live','.live-heading','Available outside Object map, nearby suggestions, tours or quiet flight'],
    ['nearby','#nearby-panel','Nearby suggestions','.nearby-head','Open Nearby images from the sidebar'],
    ['route','#route-player','Tour guide','.route-player-head','Start a tour to use this panel'],
    ['flight','#flight-panel','Flight controls','.flight-panel-head','Start Fly to use this panel'],
    ['intro','.destination-intro','Destination introduction',null,'Available outside Object map, flight or a tour'],
    ['destinations','.destination-dock','Destination shortcuts','.dock-title','Available outside flight or a tour']
  ];
  for(const [id,selector,label,head,unavailable] of definitions){
    const element=$(selector);if(!element)continue;
    if(!element.id)element.id='map-'+id;
    element.classList.add('map-managed-panel');
    const minimize=document.createElement('button');minimize.type='button';minimize.className='map-panel-minimize';
    minimize.textContent='−';minimize.title='Minimize '+label;minimize.setAttribute('aria-label','Minimize '+label);minimize.setAttribute('aria-controls',element.id);
    minimize.onclick=()=>setMapPanel(id,true);
    if(head)$(head,element).append(minimize);
    else if(id==='sidebar'){
      const header=document.createElement('div');header.className='map-sidebar-heading';
      element.prepend(header);header.append($('.overline',element),minimize);
    }else{element.append(minimize);if(id==='intro')minimize.classList.add('map-minimize-corner');}
    const row=document.createElement('label');row.className='map-panel-option';
    const input=document.createElement('input');input.type='checkbox';input.setAttribute('aria-label',label);input.setAttribute('aria-controls',element.id);
    const text=document.createElement('span'),name=document.createElement('strong'),note=document.createElement('small');
    name.textContent=label;text.append(name,note);row.append(input,text);$('#map-panel-options').append(row);
    input.onchange=()=>setMapPanel(id,!input.checked);
    mapPanelUI.panels.push({id,element,input,note,unavailable});
  }
  const flightMini=document.createElement('div');flightMini.id='map-flight-mini';flightMini.className='map-motion-mini';flightMini.hidden=true;flightMini.setAttribute('aria-label','Compact flight controls');flightMini.setAttribute('role','group');
  flightMini.innerHTML='<strong>Sky flight</strong><button id="map-flight-restore" type="button">Expand controls</button><button id="map-flight-stop" type="button">■ Stop</button><button id="map-flight-exit" type="button">Exit flight</button>';page.append(flightMini);
  const routeMini=document.createElement('div');routeMini.id='map-route-mini';routeMini.className='map-motion-mini';routeMini.hidden=true;routeMini.setAttribute('aria-label','Compact tour controls');routeMini.setAttribute('role','group');
  routeMini.innerHTML='<strong id="map-route-title"></strong><button id="map-route-restore" type="button">Expand guide</button><button id="map-route-pause" type="button">Pause</button><button id="map-route-end" type="button">End tour</button>';page.append(routeMini);
  $('#map-flight-restore').onclick=()=>{setMapPanel('flight',false);$('#flight-stop').focus({preventScroll:true});};
  $('#map-flight-stop').onclick=()=>pauseFlight();
  $('#map-flight-exit').onclick=()=>{exitFlight();$('#map-panels-toggle').focus({preventScroll:true});};
  $('#map-route-restore').onclick=()=>{setMapPanel('route',false);$('#route-play-toggle').focus({preventScroll:true});};
  $('#map-route-pause').onclick=()=>$('#route-play-toggle').click();
  $('#map-route-end').onclick=()=>{$('#route-play-close').click();$('#map-panels-toggle').focus({preventScroll:true});};
  $('#map-sidebar-toggle').onclick=()=>setMapPanel('sidebar',!mapPanelHidden('sidebar'));
  $('#map-panels-toggle').onclick=()=>menu.hidden?openMapPanelMenu():closeMapPanelMenu();
  $('#map-panel-menu-close').onclick=()=>{closeMapPanelMenu();$('#map-panels-toggle').focus({preventScroll:true});};
  $('#map-clear-view').onclick=toggleMapClearView;
  $('#map-panel-reset').onclick=()=>{mapPanelUI.layout=readMapLayout(null);saveMapLayout();applyMapLayout();closeMapPanelMenu();$('#map-panels-toggle').focus({preventScroll:true});};
  document.addEventListener('pointerdown',e=>{if(!menu.hidden&&!menu.contains(e.target)&&!toolbar.contains(e.target))closeMapPanelMenu();});
  document.addEventListener('keydown',e=>{
    if(state.page!=='explore'||$('#modal').open||e.ctrlKey||e.altKey||e.metaKey||e.repeat||e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
    if(e.code==='KeyH'){e.preventDefault();toggleMapClearView();}
    if(e.code==='Escape'&&!menu.hidden){closeMapPanelMenu();$('#map-panels-toggle').focus({preventScroll:true});}
  });
  // Observe only owner visibility and playback labels, never our own panel classes.
  const observer=new MutationObserver(syncMapPanelControls);
  for(const panel of mapPanelUI.panels)observer.observe(panel.element,{attributes:true,attributeFilter:['hidden']});
  observer.observe(page,{attributes:true,attributeFilter:['class']});
  observer.observe($('#object-detail'),{attributes:true,attributeFilter:['hidden']});
  for(const selector of ['#route-play-toggle','#route-stop-title'])observer.observe($(selector),{childList:true,characterData:true,subtree:true});
  window.addEventListener('resize',syncMapPanelControls);
  mapPanelUI.ready=true;applyMapLayout();
}
if(typeof module!=='undefined')module.exports={readMapLayout,changeMapPanel,toggleClearMap,MAP_PANEL_IDS};
