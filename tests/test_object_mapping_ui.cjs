const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/features.js'),'utf8');
function harness(){
  const nodes=new Map(),calls=[],requests=[],storage=new Map();
  const node=()=>{
    const classes=new Set();
    return {hidden:false,checked:true,value:'',innerHTML:'',textContent:'',scrollTop:0,append(){},
      classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)}};
  };
  const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const audio={currentTime:42,paused:false,pause(){this.paused=true;calls.push('pause');}};
  const context=vm.createContext({$, $$:()=>[],document:{querySelectorAll:()=>[audio],createElement:node},
    state:{sky:{},page:'explore'},currentField:()=>({ra:83.82,dec:-5.39,fov:2}),esc:String,date:String,
    clearTimeout(){},localStorage:{setItem:(key,value)=>storage.set(key,value)},
    cancelDestinationVisit:()=>calls.push('cancel-visit'),setNearbyVisible(){},
    loadObjectResearch:async o=>{calls.push('load-research');return {id:o.id};},
    api:url=>new Promise(resolve=>requests.push({url,resolve})),
  });
  vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  run(`var target={id:'simbad:M  42',name:'Orion Nebula',type:'Nebula',catalog:'SIMBAD',ra:83.82,dec:-5.39,source_url:'https://simbad.cds.unistra.fr/'};`);
  return {context,run,$,audio,calls,requests,storage};
}

test('a destination card opens with markers off without changing the overlay preference',async()=>{
  const h=harness();await h.run('showObjectDetail(target)');
  assert.equal(h.run('mapUI.enabled'),false);assert.equal(h.$('#object-markers').hidden,true);
  assert.equal(h.$('#object-panel').hidden,false);assert.equal(h.$('#object-detail').hidden,false);
  assert.equal(h.$('#explore-page').classList.contains('mapping-active'),true);
  assert.deepEqual(h.calls,['cancel-visit','pause','load-research']);assert.equal(h.storage.size,0);
});

test('hiding markers keeps the exact story card, research and playing audio untouched',async()=>{
  const h=harness();await h.run('showObjectDetail(target)');h.run('mapUI.enabled=true');
  h.audio.paused=false;h.calls.length=0;const card=h.$('#object-detail').innerHTML;
  h.run('toggleMapping(false)');
  assert.equal(h.$('#object-markers').hidden,true);assert.equal(h.$('#mapping-labels-control').hidden,true);
  assert.equal(h.$('#object-panel').hidden,false);assert.equal(h.$('#object-detail').innerHTML,card);
  assert.equal(h.run('mapUI.selected===target'),true);assert.equal(h.audio.paused,false);assert.equal(h.audio.currentTime,42);
  assert.equal(h.storage.get('universe-object-map'),'false');assert.deepEqual(h.calls,[]);assert.equal(h.requests.length,0);
});

test('restoring the overlay preserves the selected card and audio instead of opening the object list',async()=>{
  const h=harness();await h.run('showObjectDetail(target)');h.calls.length=0;h.audio.paused=false;
  const card=h.$('#object-detail').innerHTML;h.run('toggleMapping(true)');
  assert.equal(h.$('#object-markers').hidden,false);assert.equal(h.$('#object-list-view').hidden,true);
  assert.equal(h.$('#object-detail').innerHTML,card);assert.equal(h.run('mapUI.selected===target'),true);
  assert.equal(h.audio.paused,false);assert.equal(h.audio.currentTime,42);assert.deepEqual(h.calls,[]);
  assert.equal(h.requests.length,1);assert.match(h.requests[0].url,/^\/api\/objects\?/);
  assert.equal(h.storage.get('universe-object-map'),'true');
});

test('a late catalog response cannot restore hidden markers or replace the open story',async()=>{
  const h=harness();await h.run('showObjectDetail(target)');h.calls.length=0;h.audio.paused=false;
  h.run('toggleMapping(true);toggleMapping(false)');
  h.requests[0].resolve({rows:[{id:'late'}],catalog_available:true});await Promise.resolve();await Promise.resolve();
  assert.equal(h.$('#object-markers').hidden,true);assert.equal(h.$('#object-panel').hidden,false);
  assert.equal(h.run('mapUI.rows.length'),0);assert.equal(h.run('mapUI.selected===target'),true);
  assert.equal(h.audio.paused,false);assert.deepEqual(h.calls,[]);
});

test('closing the card with markers off releases the panel and intentionally stops its narration',async()=>{
  const h=harness();await h.run('showObjectDetail(target)');h.calls.length=0;h.audio.paused=false;
  h.run('showObjectList()');
  assert.equal(h.$('#object-panel').hidden,true);assert.equal(h.run('mapUI.selected'),null);
  assert.equal(h.$('#explore-page').classList.contains('mapping-active'),false);
  assert.equal(h.audio.paused,true);assert.deepEqual(h.calls,['cancel-visit','pause']);
});

test('the ordinary object list still opens and closes when no story is selected',()=>{
  const h=harness();h.run('toggleMapping(true)');
  assert.equal(h.$('#object-panel').hidden,false);assert.equal(h.$('#object-list-view').hidden,false);
  h.run('toggleMapping(false)');assert.equal(h.$('#object-panel').hidden,true);
});
