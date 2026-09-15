'use strict';
const sedUI={data:null,points:[],bounds:null,selected:null,page:1,request:0};
const SED_COLORS=['#e8bf7e','#7dd7d8','#c6a0ed','#e893b7','#88c99d','#ef966f','#a5baf5','#d0d481'];
function openPhotometry(target){closeModal();$('#sed-target').value=target;showPage('photometry');$('#sed-status').textContent='Target ready. Choose Get photometry to query VizieR.';}
function sedRows(){const catalog=$('#sed-catalog').value;return (sedUI.data?.rows||[]).map((p,i)=>({...p,index:i})).filter(p=>catalog==='all'||p.catalog===catalog);}
async function fetchPhotometry(event){
  event?.preventDefault();const request=++sedUI.request;
  const button=$('#sed-fetch');button.disabled=true;button.textContent='Querying VizieR…';$('#sed-status').textContent='Reading catalog photometry. The first query can take a minute.';
  try{
    const d=await api('/api/photometry?'+new URLSearchParams({target:$('#sed-target').value,radius:$('#sed-radius').value,refresh:$('#sed-refresh').checked}));
    if(request!==sedUI.request)return;
    sedUI.data=d;sedUI.bounds=null;sedUI.selected=null;sedUI.page=1;$('#sed-result').hidden=false;
    $('#sed-catalog').innerHTML='<option value="all">All catalogs</option>'+d.catalogs.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('#sed-votable').href=d.votable_url;
    $('#sed-status').textContent=`${d.target} · ${d.radius_arcsec}″ radius · ${fmt(d.rows.length,0)} measurements from ${d.catalogs.length} catalog tables · ${d.source} · ${d.stale?'STALE saved data':d.cached?'Saved query':'Retrieved'} ${date(d.fetched_at)}.${d.truncated?' The service truncated these results; narrow the radius.':''}`;
    drawSED();renderSEDTable();
  }catch(e){$('#sed-status').textContent=e.message;failure(e);}finally{button.disabled=false;button.textContent='Get photometry';}
}
function sedAxes(){return {x:$('#sed-axis').value==='frequency'?'frequency_ghz':'wavelength_um',label:$('#sed-axis').value==='frequency'?'Frequency (GHz)':'Wavelength (μm)'};}
function drawSED(){
  if(!sedUI.data||state.page!=='photometry')return;
  const canvas=$('#sed-plot'),rect=canvas.getBoundingClientRect(),width=Math.max(400,rect.width),height=440,dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(width*dpr);canvas.height=height*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  ctx.fillStyle='#07121b';ctx.fillRect(0,0,width,height);
  const axes=sedAxes(),rows=sedRows(),valid=rows.filter(p=>p[axes.x]>0&&p.flux_jy>0&&Number.isFinite(p[axes.x])&&Number.isFinite(p.flux_jy));
  const area={left:80,right:width-28,top:25,bottom:height-60};sedUI.area=area;
  ctx.font='12px Segoe UI';ctx.fillStyle='#a8bbc7';ctx.textAlign='center';ctx.fillText(axes.label,width/2,height-14);
  ctx.save();ctx.translate(19,height/2);ctx.rotate(-Math.PI/2);ctx.fillText('Flux density (Jy)',0,0);ctx.restore();
  if(!valid.length){ctx.fillText('No positive measurements to plot. Inspect the table below.',width/2,height/2);sedUI.points=[];return;}
  if(!sedUI.bounds){
    const xs=valid.map(p=>Math.log10(p[axes.x])),ys=valid.map(p=>Math.log10(p.flux_jy));
    let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
    if(xmin===xmax){xmin-=.3;xmax+=.3;}if(ymin===ymax){ymin-=.3;ymax+=.3;}
    const xp=(xmax-xmin)*.07,yp=(ymax-ymin)*.13;sedUI.bounds={xmin:xmin-xp,xmax:xmax+xp,ymin:ymin-yp,ymax:ymax+yp};
  }
  const b=sedUI.bounds,px=v=>area.left+(Math.log10(v)-b.xmin)/(b.xmax-b.xmin)*(area.right-area.left),py=v=>area.bottom-(Math.log10(v)-b.ymin)/(b.ymax-b.ymin)*(area.bottom-area.top);
  ctx.strokeStyle='#28404d';ctx.lineWidth=1;
  for(let n=0;n<=6;n++){
    const x=area.left+n/6*(area.right-area.left),v=b.xmin+n/6*(b.xmax-b.xmin);ctx.beginPath();ctx.moveTo(x,area.top);ctx.lineTo(x,area.bottom);ctx.stroke();ctx.fillStyle='#93aab9';ctx.textAlign='center';ctx.fillText(Number(10**v).toExponential(1),x,area.bottom+22);
  }
  for(let n=0;n<=5;n++){
    const y=area.bottom-n/5*(area.bottom-area.top),v=b.ymin+n/5*(b.ymax-b.ymin);ctx.beginPath();ctx.moveTo(area.left,y);ctx.lineTo(area.right,y);ctx.stroke();ctx.textAlign='right';ctx.fillText(Number(10**v).toExponential(1),area.left-10,y+4);
  }
  sedUI.points=[];ctx.save();ctx.beginPath();ctx.rect(area.left,area.top,area.right-area.left,area.bottom-area.top);ctx.clip();
  for(const p of valid){
    const x=px(p[axes.x]),y=py(p.flux_jy),color=SED_COLORS[sedUI.data.catalogs.indexOf(p.catalog)%SED_COLORS.length];
    ctx.fillStyle=color;ctx.strokeStyle=color;ctx.globalAlpha=.55;
    if(p.error_jy>0){const y1=py(p.flux_jy+p.error_jy),y2=p.flux_jy-p.error_jy>0?py(p.flux_jy-p.error_jy):area.bottom;ctx.beginPath();ctx.moveTo(x,y1);ctx.lineTo(x,y2);ctx.moveTo(x-3,y1);ctx.lineTo(x+3,y1);ctx.moveTo(x-3,y2);ctx.lineTo(x+3,y2);ctx.stroke();}
    ctx.globalAlpha=p.index===sedUI.selected?1:.8;ctx.beginPath();ctx.arc(x,y,p.index===sedUI.selected?6:3.7,0,2*Math.PI);ctx.fill();
    if(p.index===sedUI.selected){ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();ctx.lineWidth=1;}
    if(x>=area.left&&x<=area.right&&y>=area.top&&y<=area.bottom)sedUI.points.push({x,y,row:p});
  }
  ctx.restore();ctx.globalAlpha=1;
  const omitted=rows.length-valid.length;$('#sed-selection').textContent=sedUI.selected===null?`${valid.length} positive points shown${omitted?`; ${omitted} nonpositive or missing values retained in the table`:''}. Error bars use supplied uncertainties.`:measurementText(sedUI.data.rows[sedUI.selected]);
}
function measurementText(p){return `${p.catalog} · ${p.filter} · ${p.frequency_ghz} GHz · ${p.flux_jy} Jy${p.error_jy!==null?' ± '+p.error_jy+' Jy':' · uncertainty not supplied'} · source ${p.identifier}`;}
function renderSEDTable(){
  const rows=sedRows(),start=(sedUI.page-1)*50,slice=rows.slice(start,start+50);
  $('#sed-table').innerHTML=`<table><thead><tr><th>Catalog / source</th><th>Filter</th><th>Frequency (GHz)</th><th>Flux (Jy)</th><th>Error (Jy)</th><th>RA / Dec (°)</th></tr></thead><tbody>${slice.map(p=>`<tr data-sed-row="${p.index}" class="${p.index===sedUI.selected?'selected':''}" tabindex="0"><td><a href="${esc(p.catalog_url)}" target="_blank" rel="noopener">${esc(p.catalog)} ↗</a><small>${esc(p.identifier)}</small></td><td>${esc(p.filter)}</td><td>${p.frequency_ghz??'—'}</td><td>${p.flux_jy??'—'}</td><td>${p.error_jy??'—'}</td><td>${fmt(p.ra,7)}<br>${fmt(p.dec,7)}</td></tr>`).join('')}</tbody></table>`;
  $$('[data-sed-row]').forEach(tr=>{const select=()=>{sedUI.selected=Number(tr.dataset.sedRow);drawSED();renderSEDTable();};tr.onclick=e=>{if(!e.target.closest('a'))select();};tr.onkeydown=e=>{if(e.key==='Enter')select();};});
  $('#sed-table-prev').disabled=sedUI.page<=1;$('#sed-table-next').disabled=start+50>=rows.length;$('#sed-table-page').textContent=`${rows.length?start+1:0}–${Math.min(start+50,rows.length)} of ${rows.length} measurements`;
}
async function desktopStatus(){const d=await api('/api/aladin/status');$('#desktop-status').textContent=d.installed?`Version ${d.version} · ${d.connected?'connected through SAMP':'installed locally; opens in its own desktop window'} · Full CDS distribution, including FITS cubes, catalogs, mosaics, cross-matching, MOCs and HiPS tools.`:'Desktop package not installed. Run setup_aladin.py to install the official distribution.';return d;}
function initPhotometry(){
  $('#sed-form').onsubmit=fetchPhotometry;
  $('#sed-use-sky').onclick=()=>{const p=currentField();$('#sed-target').value=`${p.ra.toFixed(7)} ${p.dec>=0?'+':''}${p.dec.toFixed(7)}`;};
  $('#sed-axis').onchange=()=>{sedUI.bounds=null;drawSED();};$('#sed-catalog').onchange=()=>{sedUI.bounds=null;sedUI.page=1;drawSED();renderSEDTable();};$('#sed-reset-zoom').onclick=()=>{sedUI.bounds=null;drawSED();};
  $('#sed-table-prev').onclick=()=>{sedUI.page--;renderSEDTable();};$('#sed-table-next').onclick=()=>{sedUI.page++;renderSEDTable();};
  $('#sed-csv').onclick=()=>{const keys=['frequency_ghz','flux_jy','error_jy','wavelength_um','filter','catalog','identifier','ra','dec','time_jd'];const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';download([keys.join(','),...sedUI.data.rows.map(p=>keys.map(k=>cell(p[k])).join(','))].join('\r\n'),'vizier-photometry.csv','text/csv');};
  $('#aladin-open').onclick=()=>busy($('#aladin-open'),'Opening Aladin…',async()=>{await api('/api/aladin/open',{method:'POST'});toast('Aladin Desktop is opening in its own window.');await desktopStatus();});
  $('#aladin-point').onclick=()=>busy($('#aladin-point'),'Sending coordinates…',async()=>{const p=currentField();await jsonPost('/api/aladin/point',{ra:p.ra,dec:p.dec});toast('Sky position received by Aladin Desktop.');await desktopStatus();});
  $('#sed-aladin').onclick=()=>busy($('#sed-aladin'),'Sending measurements…',async()=>{await api('/api/aladin/photometry/'+sedUI.data.key,{method:'POST'});toast('Original VOTable received by Aladin Desktop.');await desktopStatus();});
  $('#image-aladin').onclick=()=>busy($('#image-aladin'),'Opening original…',async()=>{await api('/api/aladin/image/'+state.image.id,{method:'POST'});toast('Original image received by Aladin Desktop.');});
  let drag=null,dragged=false;const canvas=$('#sed-plot');
  canvas.onwheel=e=>{if(!sedUI.bounds)return;e.preventDefault();const b=sedUI.bounds,f=e.deltaY<0?.85:1/.85,mx=(b.xmax+b.xmin)/2,my=(b.ymax+b.ymin)/2,dx=(b.xmax-b.xmin)*f/2,dy=(b.ymax-b.ymin)*f/2;sedUI.bounds={xmin:mx-dx,xmax:mx+dx,ymin:my-dy,ymax:my+dy};drawSED();};
  canvas.onpointerdown=e=>{if(!sedUI.bounds)return;drag={x:e.clientX,y:e.clientY,b:{...sedUI.bounds}};dragged=false;canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{
    const rect=canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
    if(drag){const dx=(e.clientX-drag.x)/(sedUI.area.right-sedUI.area.left)*(drag.b.xmax-drag.b.xmin),dy=(e.clientY-drag.y)/(sedUI.area.bottom-sedUI.area.top)*(drag.b.ymax-drag.b.ymin);if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4)dragged=true;sedUI.bounds={xmin:drag.b.xmin-dx,xmax:drag.b.xmax-dx,ymin:drag.b.ymin+dy,ymax:drag.b.ymax+dy};drawSED();return;}
    const p=sedUI.points.map(p=>({...p,d:Math.hypot(p.x-x,p.y-y)})).sort((a,b)=>a.d-b.d)[0],tip=$('#sed-tooltip');
    tip.hidden=!p||p.d>15;if(!tip.hidden){tip.textContent=measurementText(p.row);tip.style.left=Math.min(x+12,rect.width-280)+'px';tip.style.top=Math.max(0,y-60)+'px';}
  };
  canvas.onpointerup=e=>{drag=null;if(dragged)return;const rect=canvas.getBoundingClientRect(),p=sedUI.points.map(p=>({...p,d:Math.hypot(p.x-(e.clientX-rect.left),p.y-(e.clientY-rect.top))})).sort((a,b)=>a.d-b.d)[0];if(p&&p.d<15){sedUI.selected=p.row.index;sedUI.page=Math.floor(sedRows().findIndex(r=>r.index===p.row.index)/50)+1;drawSED();renderSEDTable();}};
  canvas.onpointercancel=()=>drag=null;canvas.onpointerleave=()=>$('#sed-tooltip').hidden=true;
  window.addEventListener('resize',drawSED);new ResizeObserver(drawSED).observe($('#sed-plot'));
  desktopStatus().catch(()=>{});setInterval(()=>{if(state.page==='photometry'&&!document.hidden)desktopStatus().catch(()=>{});},10000);
}
