const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../static/object-videos.js'),'utf8');
const video={provider:'youtube',id:'KOXm7W8f6wo',title:'Orion <Nebula>',channel:'DeepSkyVideos',duration:'4:00'};
function harness(){
  const nodes=new Map(),calls=[],players=[],scripts=[];
  const $=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',hidden:false,dataset:{},setAttribute(k,v){this[k]=v;},replaceChildren(){this.innerHTML='';},pause(){calls.push(selector+':pause');},requestFullscreen:async()=>calls.push('fullscreen')});
    return nodes.get(selector);
  };
  const object={id:'simbad:M 42',name:'Orion Nebula'},destination={id:'orion',object_id:'simbad:M  42',videos:[video,{...video,id:'fkWrjrdT3Zg',title:'Orion flight'}]};
  const context=vm.createContext({$, $$:()=>[],mapUI:{selected:object},state:{config:{destinations:[destination]}},
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),location:{origin:'http://127.0.0.1:8765'},
    window:{YT:{Player:function(id,options){this.id=id;this.options=options;this.frame={};this.destroy=()=>{this.destroyed=true;calls.push('destroy');};this.pauseVideo=()=>calls.push('youtube:pause');this.playVideo=()=>calls.push('youtube:play');this.getIframe=()=>this.frame;players.push(this);}}},
    document:{head:{append(script){scripts.push(script);}},createElement:()=>({remove(){}})},setTimeout:()=>1,clearTimeout(){},
    cancelDestinationVisit:()=>calls.push('cancel-visit'),pauseTourNarration:()=>calls.push('pause-tour')});
  vm.runInContext(code,context);const run=text=>vm.runInContext(text,context);
  return {context,run,$,calls,players,scripts,object,destination};
}

test('canonical SIMBAD cards and legacy featured cards share the correct destination videos',()=>{
  const h=harness();assert.equal(h.context.objectVideoItems(h.object).length,2);
  assert.equal(h.context.objectVideoItems({id:'orion'}).length,2);
  assert.equal(h.context.objectVideoItems({id:'simbad:M 43'}).length,0);
  assert.equal(h.context.objectVideoItems({id:'unknown',videos:[{...video,id:'bad" onload="evil'}]}).length,0);
});

test('opening the shelf escapes titles and does not load a YouTube player or pause narration',()=>{
  const h=harness();h.context.renderObjectVideos(h.object);
  assert.match(h.$('#object-videos').innerHTML,/Orion &lt;Nebula>/);assert.doesNotMatch(h.$('#object-videos').innerHTML,/<iframe/);
  assert.match(h.$('#object-videos').innerHTML,/Videos about Orion Nebula/);assert.equal(h.players.length,0);assert.deepEqual(h.calls,[]);
});

test('selecting a video pauses narration and uses a single privacy-enhanced player with a fallback link',async()=>{
  const h=harness();h.context.renderObjectVideos(h.object);await h.context.playObjectYouTube(h.object,0);
  assert.ok(h.calls.includes('cancel-visit'));assert.ok(h.calls.includes('#object-research-audio:pause'));assert.ok(h.calls.includes('pause-tour'));
  const p=h.players[0];assert.equal(p.options.host,'https://www.youtube-nocookie.com');assert.equal(p.options.playerVars.origin,'http://127.0.0.1:8765');
  p.options.events.onReady({target:p});assert.ok(h.calls.includes('youtube:play'));assert.equal(p.frame.referrerPolicy,'strict-origin-when-cross-origin');
  assert.equal(h.$('#object-video-watch').href,'https://www.youtube.com/watch?v=KOXm7W8f6wo');
  await h.context.playObjectYouTube(h.object,1);assert.equal(p.destroyed,true);assert.equal(h.players.length,2);
});

test('research narration pauses the video; starting the video again pauses research without losing the player',async()=>{
  const h=harness();h.context.renderObjectVideos(h.object);await h.context.playObjectYouTube(h.object,0);
  const p=h.players[0];p.options.events.onReady({target:p});h.calls.length=0;
  h.context.pauseObjectVideos();assert.ok(h.calls.includes('youtube:pause'));assert.ok(h.calls.includes('#object-video:pause'));assert.equal(p.destroyed,undefined);
  h.calls.length=0;p.options.events.onStateChange({target:p,data:1});assert.ok(h.calls.includes('#object-research-audio:pause'));
});

test('switching objects while the API loads cannot create a stale player',async()=>{
  const h=harness();h.context.window.YT=null;let finish;h.context.loadObjectYouTubeAPI=()=>new Promise(resolve=>finish=resolve);
  h.context.renderObjectVideos(h.object);const pending=h.context.playObjectYouTube(h.object,0);
  h.context.stopObjectVideoLibrary();h.context.mapUI.selected={id:'different'};finish({Player(){throw Error('stale player');}});await pending;
  assert.equal(h.players.length,0);assert.equal(h.$('#object-video-stage').hidden,true);
});

test('native video playback cancels a pending YouTube load without pausing itself',async()=>{
  const h=harness();h.context.window.YT=null;let finish;h.context.loadObjectYouTubeAPI=()=>new Promise(resolve=>finish=resolve);
  h.context.renderObjectVideos(h.object);const pending=h.context.playObjectYouTube(h.object,0);h.calls.length=0;
  h.context.pauseObjectVideos(true);finish({Player(){throw Error('late player');}});await pending;
  assert.deepEqual(h.calls,[]);
});

test('a minimized or closed player can be selected again from the preserved shelf',async()=>{
  const h=harness();h.context.renderObjectVideos(h.object);await h.context.playObjectYouTube(h.object,0);
  h.context.stopObjectVideoLibrary();assert.equal(h.players[0].destroyed,true);
  await h.context.playObjectYouTube(h.object,1);assert.equal(h.players.length,2);assert.equal(h.$('#object-video-stage').hidden,false);
});

test('provider restrictions and API failures leave a working YouTube link and saved research intact',async()=>{
  const h=harness();h.context.renderObjectVideos(h.object);await h.context.playObjectYouTube(h.object,0);
  const p=h.players[0];p.options.events.onError({target:p,data:150});assert.match(h.$('#object-video-status').textContent,/Watch on YouTube/);
  h.context.loadObjectYouTubeAPI=()=>Promise.reject(Error('Network unavailable'));await h.context.playObjectYouTube(h.object,1);
  assert.equal(h.$('#object-video-status').textContent,'Network unavailable');assert.equal(h.$('#object-video-watch').href,'https://www.youtube.com/watch?v=fkWrjrdT3Zg');
  assert.equal(h.context.mapUI.selected,h.object);
});
