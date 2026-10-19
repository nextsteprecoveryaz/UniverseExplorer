const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/notebook.js'),'utf8');
function harness(){
  const nodes=new Map(),calls=[],$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,checked:false,reportValidity:()=>true,scrollIntoView(){}});return nodes.get(id);};
  const state={survey:'optical'},context=vm.createContext({$,state,$$:()=>[],Number,Math,FormData,console,
    esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),storySourcesMarkup:()=>'',
    resetTourNarration:()=>calls.push('reset'),navigationUI:{dirty:false},
    loadSavedRoutes:async()=>calls.push('loaded'),editSavedRoute:async id=>calls.push(['edit',id]),playSavedRoute:async id=>calls.push(['play',id]),
    toast:()=>{},failure:e=>calls.push(['error',e.message]),loadNotes:async()=>{},
    jsonPost:async(url,body)=>{calls.push([url,JSON.parse(JSON.stringify(body))]);return {id:'route'};},
    api:async()=>{calls.push('upload');return {id:'image'};},
  });vm.runInContext(source,context);return {context,run:s=>vm.runInContext(s,context),$,calls,state};
}
test('right-click converts CSS pixel location to ICRS and preserves the original field separately',()=>{
  const h=harness();let point;
  const sky={pix2world:(x,y,frame)=>(point=[x,y,frame],[-.1,30]),getRaDec:()=>[20,40],getFov:()=>[2],getRotation:()=>13,getProjectionName:()=>'SIN'};
  const r=h.context.notebookLocation({clientX:120,clientY:90},sky,{left:20,top:30,width:800,height:400});
  assert.deepEqual(point,[100,60,'ICRS']);assert.equal(r.ra,359.9);assert.equal(r.dec,30);assert.equal(r.view.ra,20);assert.equal(r.view.roll,13);assert.equal(r.search_radius_arcsec,54);
});
test('void and off-map clicks cannot become false zero-coordinate bookmarks',()=>{
  const h=harness(),rect={left:0,top:0,width:500,height:400},event={clientX:100,clientY:100};
  assert.equal(h.context.notebookLocation(event,{pix2world:()=>[NaN,NaN]},rect),null);
  assert.equal(h.context.notebookLocation(event,{pix2world:()=>{throw Error('void');}},rect),null);
  assert.equal(h.context.notebookLocation({clientX:600,clientY:10},{},rect),null);
});
test('right-clicking a published image marker saves its anchor coordinates rather than label pixels',()=>{
  const h=harness(),sky={pix2world:()=>[10,20],getRaDec:()=>[10,20],getFov:()=>[1]};
  const event={clientX:100,clientY:100,target:{closest:()=>({dataset:{ra:'83.8201',dec:'-5.3876'}})}};
  const result=h.context.notebookLocation(event,sky,{left:0,top:0,width:500,height:400});
  assert.ok(Math.abs(result.ra-83.8201)<1e-9);assert.equal(result.dec,-5.3876);assert.equal(result.view.ra,10);
});
test('keyboard context menu uses the map center and zero sky coordinates remain valid',()=>{
  const h=harness();let point;const sky={pix2world:(x,y)=>(point=[x,y],[0,0]),getRaDec:()=>[0,0],getFov:()=>[360]};
  const r=h.context.notebookLocation({clientX:0,clientY:0},sky,{left:10,top:10,width:500,height:400});
  assert.deepEqual(point,[250,200]);assert.equal(r.ra,0);assert.equal(r.search_radius_arcsec,180);
});
test('catalog label right-click saves its anchor and name even when label text is offset',()=>{
  const h=harness();h.context.mapUI={rows:[{id:'simbad:NGC  1635',name:'NGC 1635',ra:70.0328375,dec:-.5475611}],enabled:false};
  const sky={pix2world:()=>[70.04,-.54],getRaDec:()=>[70.0328,-.5475],getFov:()=>[.04]};
  const event={clientX:150,clientY:100,target:{closest:selector=>selector.startsWith('#object-markers')?{dataset:{mapId:'simbad:NGC  1635'}}:null}};
  const result=h.context.notebookLocation(event,sky,{left:0,top:0,width:500,height:400});
  assert.ok(Math.abs(result.ra-70.0328375)<1e-9);assert.equal(result.object_hint.name,'NGC 1635');assert.equal(result.dec,-.5475611);
});
test('narrated notebook routes restore their explicitly selected provider and enable speech',()=>{
  const h=harness();h.context.activateNotebookNarration({stops:[{guide:{narrator:'browser'}}]});
  assert.equal(h.$('#route-narration').checked,true);assert.equal(h.$('#tour-narration-provider').value,'browser');assert.equal(h.$('#tour-narration-voice').disabled,true);
  h.context.activateNotebookNarration({stops:[{guide:{narrator:'openai'}}]});assert.equal(h.$('#tour-narration-provider').value,'openai');
});
test('manual scripts take precedence without overwriting the researched draft',()=>{
  const h=harness();assert.equal(h.run("notebookScript({research:{story:'Research',edited_narration:'My story'}})"),'My story');
  assert.equal(h.run("notebookScript({research:{story:'Research'}})"),'Research');
  assert.equal(h.run("notebookImage({provenance:{image_id:'../../secret'}})"),null);
});
test('snapshot upload is reused if saving the note needs a retry',async()=>{
  const h=harness(),capture={blob:new Blob(['image'],{type:'image/png'})};
  const values={title:'Snapshot',provenance:{ra:0,dec:0}};
  await h.context.attachNotebookSnapshot(values,capture);await h.context.attachNotebookSnapshot(values,capture);
  assert.equal(h.calls.filter(c=>c==='upload').length,1);assert.equal(capture.image.id,'image');
});
test('tour creation sends selection order and revisions and waits for saving before playing',async()=>{
  const h=harness();h.run("notebookUI.notes=[{id:'first',revision:2,research:{story:'A'}},{id:'second',revision:7,research:{story:'B'}}];notebookUI.selected=['second','first']");
  h.$('#notebook-tour-title').value='My route';h.$('#notebook-tour-voice').value='browser';
  await h.context.createNotebookTour(true);
  assert.deepEqual(h.calls[0],['/api/notebook/tour',{title:'My route',narrator:'browser',entries:[{id:'second',revision:7},{id:'first',revision:2}]}]);
  assert.deepEqual(h.calls.slice(1),['loaded',['edit','route'],['play','route']]);assert.equal(h.run('notebookUI.saving'),false);
});
test('tour failure keeps the selection for recovery and releases the buttons',async()=>{
  const h=harness();h.run("notebookUI.notes=[{id:'one',revision:2,research:{story:'A'}}];notebookUI.selected=['one']");
  h.$('#notebook-tour-title').value='Tour';h.context.jsonPost=async()=>{throw Error('Entry changed');};
  await h.context.createNotebookTour(true);assert.equal(h.run('notebookUI.selected[0]'),'one');assert.equal(h.run('notebookUI.saving'),false);
  assert.deepEqual(h.calls,[['error','Entry changed']]);
});
