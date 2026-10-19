const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/object-research.js'),'utf8');
const object={id:'simbad:Haro 5-56',name:'Haro 5-56',catalog:'SIMBAD',ra:85.635742,dec:-1.636791,type:'Young stellar object',summary:'Catalog description.'};
const saved={id:'a'.repeat(64),status:'ready',research:{narration:'The exact saved story.',story:{paragraphs:[]},sources:[],created_at:'2026-10-19'},audio:null};
function harness(){
  const nodes=new Map(),requests=[],timers=[],calls=[];
  const node=()=>({innerHTML:'',textContent:'',disabled:false,hidden:false,ended:false,currentTime:0,play(){calls.push('play');return Promise.resolve();}});
  const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const ctx=vm.createContext({$,console,mapUI:{selected:object},setTimeout:fn=>(timers.push(fn),timers.length),clearTimeout:()=>{},
    esc:s=>String(s??'').replaceAll('<','&lt;'),date:()=>'',tourStoryMarkup:()=>'<p>The exact saved story.</p>',storySourcesMarkup:()=>'',
    pauseTourNarration:()=>calls.push('pause-tour'),openCloudConnection:async()=>{},openElevenLabsConnection:async()=>{},failure:()=>{},
    jsonPost:(url,body)=>new Promise((resolve,reject)=>requests.push({url,body:JSON.parse(JSON.stringify(body)),resolve,reject})),
    api:url=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})),
  });vm.runInContext(source,ctx);return {ctx,$,run:s=>vm.runInContext(s,ctx),requests,timers,calls};
}

test('opening a card only looks up saved research and never requests generation',async()=>{
  const h=harness(),pending=h.run('loadObjectResearch(mapUI.selected)');
  assert.equal(h.requests[0].url,'/api/object-research/lookup');h.requests[0].resolve(saved);await pending;
  assert.equal(h.requests.length,1);assert.match(h.$('#object-research').innerHTML,/Saved research/);
  assert.match(h.$('#object-research').innerHTML,/Create narration/);assert.equal(h.run('objectResearchUI.record.research.narration'),saved.research.narration);
});

test('explicit research saves a story without requesting audio and ignores a late response for another object',async()=>{
  const h=harness();let pending=h.run('loadObjectResearch(mapUI.selected)');h.requests[0].resolve({id:saved.id,status:'empty'});await pending;
  pending=h.run('runObjectResearch(mapUI.selected,objectResearchUI.serial)');
  assert.equal(h.requests[1].url,'/api/object-research/research');assert.equal(h.requests[1].body.retry,false);
  h.requests[1].resolve(saved);await pending;assert.equal(h.requests.length,2);assert.equal(h.run('objectResearchUI.pending'),false);
  const old=h.run('loadObjectResearch(mapUI.selected)');h.ctx.mapUI.selected={...object,id:'other',name:'Other object'};
  const current=h.run('loadObjectResearch(mapUI.selected)');
  h.requests[3].resolve({id:'b'.repeat(64),status:'empty'});await current;
  h.requests[2].resolve(saved);await old;
  assert.equal(h.run('objectResearchUI.record.id'),'b'.repeat(64));assert.doesNotMatch(h.$('#object-research').innerHTML,/Saved research/);
});

test('create narration uses saved server identity instead of edited or catalog text',async()=>{
  const h=harness(),loading=h.run('loadObjectResearch(mapUI.selected)');h.requests[0].resolve(saved);await loading;
  const narration=h.run('createObjectNarration(mapUI.selected,objectResearchUI.serial)');
  assert.equal(h.requests[1].url,'/api/object-research/'+saved.id+'/narration');assert.deepEqual(h.requests[1].body,{});
  h.requests[1].resolve({url:'/saved.mp3',cached:false});await narration;
  assert.match(h.$('#object-research').innerHTML,/Listen to narration/);
  assert.equal(h.calls.length,0);await h.$('#object-listen').onclick();
  assert.deepEqual(h.calls,['pause-tour','play']);assert.equal(h.requests.length,2);
});

test('audio failure leaves the story and add-to-tour available',async()=>{
  const h=harness(),loading=h.run('loadObjectResearch(mapUI.selected)');h.requests[0].resolve(saved);await loading;
  const narration=h.run('createObjectNarration(mapUI.selected,objectResearchUI.serial)');h.requests[1].reject(Error('Connect ElevenLabs'));await narration;
  assert.equal(h.run('objectResearchUI.record.research.narration'),saved.research.narration);
  assert.match(h.$('#object-research').innerHTML,/Add to tour/);assert.match(h.$('#object-research-status').textContent,/research is still saved/);
});

test('returning during research polls only local state',async()=>{
  const h=harness(),loading=h.run('loadObjectResearch(mapUI.selected)');h.requests[0].resolve({id:saved.id,status:'researching'});await loading;
  assert.equal(h.timers.length,1);const poll=h.timers[0]();assert.equal(h.requests[1].url,'/api/object-research/'+saved.id);
  h.requests[1].resolve(saved);await poll;assert.match(h.$('#object-research').innerHTML,/Saved research/);assert.equal(h.requests.length,2);
});

test('failed lookup offers reload without risking a new paid request',async()=>{
  const h=harness(),loading=h.run('loadObjectResearch(mapUI.selected)');h.requests[0].reject(Error('Saved record needs repair'));await loading;
  assert.match(h.$('#object-research').innerHTML,/Reload saved research/);assert.doesNotMatch(h.$('#object-research').innerHTML,/Research Object/);
  assert.equal(h.requests.length,1);
});
