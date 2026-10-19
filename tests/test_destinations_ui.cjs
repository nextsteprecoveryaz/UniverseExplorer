const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'../static',file),'utf8');
const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../resources/dss2-destinations.json'),'utf8')).destinations;
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const record=(id='a'.repeat(64),audio=null)=>({id,status:'ready',research:{narration:'The approved astronomy story.',story:{identified:true,paragraphs:[]},sources:[],created_at:'2026-10-19'},audio});
function harness(){
  const nodes=new Map(),requests=[],timers=new Map(),calls=[];let timer=0,clock=0,field={ra:0,dec:0,fov:360};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:true,innerHTML:'',textContent:'',hidden:false,disabled:false,ended:false,currentTime:0,scrollLeft:0,clientWidth:600,scrollWidth:11000,events:{},
    pause(){calls.push('pause');},play(){calls.push('play');return this.failPlay?Promise.reject(Error('gesture')):Promise.resolve();},addEventListener(e,f){this.events[e]=f;},scrollBy(v){this.scrollLeft+=v.left;}});return nodes.get(id);};
  const c=vm.createContext({$, $$:()=>[],console,document:{activeElement:null},window:{addEventListener(){}},
    state:{sky:{},page:'explore',survey:'2mass',config:{destinations:catalog}},mapUI:{enabled:false,selected:null},
    esc:s=>String(s??''),date:()=>'',tourStoryMarkup:()=>'<p>Saved story</p>',storySourcesMarkup:()=>'',failure:e=>{throw e;},
    localStorage:{getItem:()=>null,setItem(){}},performance:{now:()=>clock},requestAnimationFrame:fn=>fn(),
    setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
    currentField:()=>field,FlightMath:{separation:(a,b)=>Math.hypot(a.ra-b.ra,a.dec-b.dec)},
    setMapPanel(){},toggleMapping(){c.mapUI.enabled=true;},pauseTourNarration(){},openCloudConnection:async()=>{},openElevenLabsConnection:async()=>{},toast:m=>calls.push(m),
    jsonPost:(url,body)=>new Promise((resolve,reject)=>requests.push({url,body,resolve,reject})),
    api:url=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})),
    flyTo:d=>{c.cancelDestinationVisit();c.state.survey=d.survey;calls.push('fly:'+d.id);},
    stopObjectVideo:()=>c.cancelDestinationVisit(),
  });
  vm.runInContext(read('object-research.js'),c);vm.runInContext(read('destinations.js'),c);
  c.showObjectDetail=o=>{c.cancelDestinationVisit();c.mapUI.selected=o;return c.loadObjectResearch(o);};
  return {c,$,requests,calls,run:s=>vm.runInContext(s,c),visit:i=>c.visitDestinationShortcut(catalog[i]),
    async arrive(i){field={...catalog[i]};clock+=3500;const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();await settle();},
  };
}

test('arrival precedes research; the saved story precedes ElevenLabs, then audio plays',async()=>{
  const h=harness(),done=h.visit(2);await settle();assert.equal(h.c.state.survey,'optical');
  assert.equal(h.requests[0].url,'/api/object-research/lookup');h.requests[0].resolve({id:'a'.repeat(64),status:'empty'});await settle();
  assert.equal(h.requests.length,1);await h.arrive(2);
  assert.equal(h.requests[1].url,'/api/object-research/research');assert.equal(h.requests[1].body.target.name,'M 42');
  h.requests[1].resolve(record());await settle();assert.equal(h.requests[2].url,'/api/object-research/'+record().id+'/narration');
  h.requests[2].resolve({url:'/saved.mp3',cached:false});await done;
  assert.equal(h.calls.filter(v=>v==='play').length,1);assert.match(h.$('#destination-status').textContent,/playing saved ElevenLabs/);
});

test('return visits play cached audio without research or synthesis requests',async()=>{
  const h=harness(),done=h.visit(4);h.requests[0].resolve(record('b'.repeat(64),{url:'/existing.mp3',cached:true}));await h.arrive(4);await done;
  assert.equal(h.requests.length,1);assert.equal(h.calls.filter(v=>v==='play').length,1);
});

test('changing destinations during research preserves its result but never starts old speech',async()=>{
  const h=harness(),first=h.visit(2);h.requests[0].resolve({id:'a'.repeat(64),status:'empty'});await h.arrive(2);
  const second=h.visit(4);h.requests[2].resolve(record('b'.repeat(64),{url:'/andromeda.mp3'}));await h.arrive(4);await second;
  h.requests[1].resolve(record());await first;
  assert.equal(h.requests.length,3);assert.equal(h.calls.filter(v=>v==='play').length,1);assert.equal(h.run('objectResearchUI.record.id'),'b'.repeat(64));
});

test('late synthesis from a previous destination cannot autoplay',async()=>{
  const h=harness(),first=h.visit(2);h.requests[0].resolve(record());await h.arrive(2);
  assert.match(h.requests[1].url,/\/narration$/);h.run('cancelDestinationVisit()');h.requests[1].resolve({url:'/late.mp3'});await first;
  assert.equal(h.calls.includes('play'),false);
});

test('manual cancellation before arrival makes no paid request',async()=>{
  const h=harness(),done=h.visit(2);h.requests[0].resolve({id:record().id,status:'empty'});await settle();h.run('cancelDestinationVisit()');await done;
  assert.equal(h.requests.length,1);assert.equal(h.calls.includes('play'),false);
});

test('Narrate visits off opens research without generating or speaking',async()=>{
  const h=harness();h.$('#destination-auto-narrate').checked=false;const done=h.visit(2);
  h.requests[0].resolve({id:record().id,status:'empty'});await h.arrive(2);await done;assert.equal(h.requests.length,1);assert.equal(h.calls.includes('play'),false);
});

test('unfinished research is not automatically retried or billed on revisit',async()=>{
  const h=harness(),done=h.visit(2);h.requests[0].resolve({id:record().id,status:'unfinished',error:'Earlier attempt interrupted'});await h.arrive(2);await done;
  assert.equal(h.requests.length,1);assert.match(h.$('#destination-status').textContent,/Retry research/);
});

test('browser autoplay restrictions leave the saved recording ready for a click',async()=>{
  const h=harness();h.$('#object-research-audio').failPlay=true;const done=h.visit(2);h.requests[0].resolve(record(record().id,{url:'/saved.mp3'}));await h.arrive(2);await done;
  assert.match(h.$('#destination-status').textContent,/click Listen/);assert.equal(h.requests.length,1);
});

test('all 50 are rendered with two-digit numbering and searchable catalog names and categories',()=>{
  const h=harness();h.run('initDestinationShortcuts()');const html=h.$('#destinations').innerHTML;
  assert.equal((html.match(/data-destination=/g)||[]).length,50);assert.match(html,/>50<\/span>/);assert.doesNotMatch(html,/>050</);
  assert.equal(h.c.shortcutMatches(catalog[0],'M16',''),true);assert.equal(h.c.shortcutMatches(catalog[4],'Andromeda','Nebulae'),false);
  h.$('#destination-search').value='Whirlpool';h.run('renderDestinationShortcuts()');assert.match(h.$('#destination-count').textContent,/1 of 50/);
});

test('mouse-wheel scrolls the strip without zooming the sky and arrows reach later destinations',()=>{
  const h=harness();h.run('initDestinationShortcuts()');let prevented=false,stopped=false;
  h.$('#destinations').events.wheel({deltaY:140,deltaX:0,deltaMode:0,preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.equal(h.$('#destinations').scrollLeft,140);assert.ok(prevented&&stopped);
  h.$('#destinations-next').onclick();assert.ok(h.$('#destinations').scrollLeft>140);
});
