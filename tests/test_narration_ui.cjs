const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/narration.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

test('saved object tour narration keeps its frozen script and original ElevenLabs voice',async()=>{
  const h=narrator('elevenlabs');
  h.run("routePlayer.route.stops[0].guide={research_id:'saved-object',narration:'The exact approved story.',voice_id:'BNgbHR0DNeZixGQVzloa'}");
  const pending=h.run('startTourNarration()');
  assert.equal(h.requests[0].url,'/api/object-research/clip');
  assert.equal(h.requests[0].body.narration,'The exact approved story.');
  assert.equal(h.requests[0].body.voice_id,'BNgbHR0DNeZixGQVzloa');
  h.resolve(0,'/saved-object.mp3',true);await pending;assert.equal(h.audio.src,'/saved-object.mp3');
});

test('Windows narration requests only the local WAV endpoint and uses the audio player',async()=>{
  const h=narrator();h.$('#tour-narration-provider').value='windows';
  const pending=h.run('startTourNarration()');
  assert.equal(h.requests[0].url,'/api/narration/local/clip');assert.equal(h.requests[0].body.voice,undefined);
  h.requests[0].resolve({url:'/api/narration/local/audio/test.wav',voice:'Microsoft David Desktop',cached:false});await pending;
  assert.equal(h.audio.src,'/api/narration/local/audio/test.wav');assert.equal(h.audio.paused,false);
  assert.match(h.$('#tour-narration-status').textContent,/Windows narration/);
});

function narrator(preference='openai'){
  const nodes=new Map(),requests=[],spoken=[],calls=[];
  const node=()=>({value:'',checked:false,disabled:false,textContent:'',listeners:{},
    parentElement:{lastChild:{textContent:''}},before(){},after(){},setAttribute(){},
    addEventListener(type,fn){this.listeners[type]=fn;},
  });
  const audio={src:'',ended:false,paused:true,currentTime:0,playbackRate:1,playError:null,
    pause(){this.paused=true;calls.push('audio-pause');},
    play(){calls.push('audio-play');if(this.playError)return Promise.reject(this.playError);this.paused=false;return Promise.resolve();},
    load(){this.ended=false;this.currentTime=0;this.paused=true;},
    removeAttribute(name){if(name==='src')this.src='';},
    getAttribute(name){return name==='src'?this.src:null;},
    finish(){this.ended=true;this.paused=true;this.onended?.();},
  };
  nodes.set('#tour-narration-audio',audio);
  const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  $('#route-narration').checked=true;$('#tour-narration-provider').value='openai';
  $('#tour-narration-voice').value='cedar';$('#route-play-speed').value='1';
  // Web Speech specifies that cancel() and speak() do not clear paused state.
  const speech={paused:false,current:null,
    pause(){this.paused=true;calls.push('speech-pause');},
    resume(){this.paused=false;calls.push('speech-resume');},
    cancel(){this.current=null;calls.push('speech-cancel');},
    speak(utterance){this.current=utterance;spoken.push(utterance);},
  };
  const route={id:'tour',revision:1,kind:'waypoints',stops:[{title:'M87',notes:''},{title:'M86',notes:''}],media:[{description:'Explore the smooth central glow.'},{description:'Compare the neighboring galaxy.'}]};
  const c=vm.createContext({$,console,window:{speechSynthesis:speech},document:{createElement:node},localStorage:{getItem:()=>preference,setItem:(_k,v)=>{preference=v;}},
    routePlayer:{route,index:0,playing:true},
    narrationFor:(media,stop)=>[stop?.title,media?.description||stop?.notes||''].filter(Boolean).join('. '),
    SpeechSynthesisUtterance:class{constructor(text){this.text=text;}},
    jsonPost:(url,body)=>new Promise((resolve,reject)=>requests.push({url,body:plain(body),resolve,reject})),
    openCloudConnection:async scope=>calls.push('connection-'+scope),failure:error=>{throw error;},
  });
  vm.runInContext(source,c);
  const run=code=>vm.runInContext(code,c);
  run('initTourNarration()');
  return {c,$,run,audio,speech,spoken,requests,calls,
    resolve(index=0,url='/api/narration/audio/clip.mp3',cached=false){requests[index].resolve({url,cached});},
  };
}

test('a response from the previous stop cannot replace the new stop audio or clear its pending state',async()=>{
  const p=narrator(),old=p.run('startTourNarration()');
  p.run('routePlayer.index=1;resetTourNarration()');
  const current=p.run('startTourNarration()');
  assert.equal(p.requests.length,2);
  p.resolve(0,'/old.mp3');await old;
  assert.equal(p.audio.src,'');assert.equal(p.run('tourNarration.pending'),true);
  p.resolve(1,'/new.mp3');await current;
  assert.equal(p.audio.src,'/new.mp3');
  assert.equal(p.calls.filter(call=>call==='audio-play').length,1);
  assert.match(p.requests[1].body.text,/^M86\./);
});

test('turning narration off invalidates a pending response and releases the route hold',async()=>{
  const p=narrator(),pending=p.run('startTourNarration()');
  p.$('#route-narration').checked=false;p.$('#route-narration').onchange();
  p.resolve();await pending;
  assert.equal(p.audio.src,'');assert.equal(p.run('tourNarrationPending()'),false);
  assert.equal(p.calls.includes('audio-play'),false);
  await p.run('startTourNarration()');assert.equal(p.requests.length,1);
});

test('a clip arriving while paused waits for route resume and reuses the prepared audio',async()=>{
  const p=narrator(),pending=p.run('startTourNarration()');
  p.run('routePlayer.playing=false;pauseTourNarration()');
  p.resolve();await pending;
  assert.equal(p.audio.paused,true);assert.equal(p.calls.includes('audio-play'),false);
  p.run('routePlayer.playing=true;resumeTourNarration()');
  await p.run('startTourNarration()');
  assert.equal(p.audio.paused,false);assert.equal(p.requests.length,1);
});

test('pause and resume retain audio position without requesting another clip',async()=>{
  const p=narrator(),pending=p.run('startTourNarration()');p.resolve();await pending;
  p.audio.currentTime=12.5;
  p.run('routePlayer.playing=false;pauseTourNarration()');
  assert.equal(p.audio.paused,true);assert.equal(p.audio.currentTime,12.5);
  p.run('routePlayer.playing=true;resumeTourNarration()');await settle();
  assert.equal(p.audio.paused,false);assert.equal(p.audio.currentTime,12.5);
  assert.equal(p.requests.length,1);
});

test('replay uses the same cache endpoint and text/voice key and can play while the route is paused',async()=>{
  const p=narrator(),first=p.run('startTourNarration()');p.resolve();await first;p.audio.finish();
  assert.equal(p.run('tourNarrationPending()'),false);
  p.run('routePlayer.playing=false;pauseTourNarration()');
  const replay=p.run('startTourNarration(true)');
  assert.equal(p.requests.length,2);
  assert.equal(p.requests[1].url,'/api/narration/clip');
  assert.deepEqual(p.requests[1].body,p.requests[0].body);
  p.resolve(1,'/api/narration/audio/clip.mp3',true);await replay;
  assert.equal(p.audio.paused,false);assert.equal(p.audio.currentTime,0);
  assert.equal(p.c.routePlayer.playing,false);
});

test('duplicate starts and an API error never trigger automatic retry for the same stop',async()=>{
  const p=narrator(),pending=p.run('startTourNarration()');
  await p.run('startTourNarration()');assert.equal(p.requests.length,1);
  p.requests[0].reject(new Error('No API connection'));await pending;
  for(let i=0;i<3;i++)await p.run('startTourNarration()');
  assert.equal(p.requests.length,1);assert.equal(p.run('tourNarrationPending()'),false);
  assert.match(p.$('#tour-narration-status').textContent,/No API connection.*Replay narration/);
  const replay=p.run('startTourNarration(true)');assert.equal(p.requests.length,2);
  p.resolve(1);await replay;assert.equal(p.audio.paused,false);
});

test('an audio playback error releases the hold and waits for explicit replay',async()=>{
  const p=narrator();p.audio.playError=new Error('Autoplay blocked');
  const pending=p.run('startTourNarration()');p.resolve();await pending;
  assert.equal(p.run('tourNarrationPending()'),false);
  assert.match(p.$('#tour-narration-status').textContent,/click to play/);
  await p.run('startTourNarration()');
  assert.equal(p.requests.length,1);assert.equal(p.calls.filter(call=>call==='audio-play').length,1);
  p.audio.playError=null;const replay=p.run('startTourNarration(true)');p.resolve(1,undefined,true);await replay;
  assert.equal(p.audio.paused,false);assert.equal(p.run('tourNarration.error'),false);
});

test('changing voice cancels the previous generation and uses the selected voice',async()=>{
  const p=narrator(),old=p.run('startTourNarration()');
  p.$('#tour-narration-voice').value='coral';p.$('#tour-narration-voice').onchange();
  assert.equal(p.requests.length,2);assert.equal(p.requests[1].body.voice,'coral');
  p.resolve(1,'/coral.mp3');await settle();
  p.resolve(0,'/cedar.mp3');await old;
  assert.equal(p.audio.src,'/coral.mp3');
  assert.equal(p.calls.filter(call=>call==='audio-play').length,1);
});

test('changing provider discards cloud responses and old browser completion callbacks',async()=>{
  const p=narrator(),old=p.run('startTourNarration()');
  p.$('#tour-narration-provider').value='browser';p.$('#tour-narration-provider').onchange();
  assert.equal(p.$('#tour-narration-voice').disabled,true);
  assert.equal(p.spoken.length,1);const utterance=p.spoken[0];
  p.resolve(0,'/stale.mp3');await old;
  assert.equal(p.audio.src,'');assert.equal(p.run('tourNarrationPending()'),true);
  p.$('#tour-narration-provider').value='openai';p.$('#tour-narration-provider').onchange();
  assert.equal(p.$('#tour-narration-voice').disabled,false);
  utterance.onend();
  assert.equal(p.run('tourNarration.pending'),true);
  assert.match(p.$('#tour-narration-status').textContent,/Checking saved OpenAI/);
  p.resolve(1,'/current.mp3');await settle();assert.equal(p.audio.src,'/current.mp3');
});

test('browser replay after a pause resumes the synthesizer before speaking',async()=>{
  const p=narrator();p.$('#tour-narration-provider').value='browser';
  await p.run('startTourNarration()');
  p.run('routePlayer.playing=false;pauseTourNarration()');
  assert.equal(p.speech.paused,true);
  await p.run('startTourNarration(true)');
  assert.equal(p.speech.paused,false);
  assert.equal(p.spoken.length,2);assert.equal(p.requests.length,0);
  assert.equal(p.c.routePlayer.playing,false);
});

test('browser narration errors release the hold and do not automatically enqueue another utterance',async()=>{
  const p=narrator();p.$('#tour-narration-provider').value='browser';
  await p.run('startTourNarration()');p.spoken[0].onerror();
  assert.equal(p.run('tourNarrationPending()'),false);
  await p.run('startTourNarration()');assert.equal(p.spoken.length,1);
  assert.match(p.$('#tour-narration-status').textContent,/Replay narration/);
});

test('ElevenLabs is the default narrator, requests its dedicated cache and preserves replay identity',async()=>{
  const p=narrator(null);assert.equal(p.$('#tour-narration-provider').value,'elevenlabs');
  assert.equal(p.$('#route-narration').checked,true);assert.equal(p.$('#tour-narration-voice').parentElement.hidden,true);
  const first=p.run('startTourNarration()');assert.equal(p.requests[0].url,'/api/narration/elevenlabs/clip');
  assert.deepEqual(Object.keys(p.requests[0].body),['text']);p.resolve(0,'/eleven.mp3');await first;
  assert.match(p.$('#tour-narration-status').textContent,/Playing ElevenLabs/);p.audio.finish();
  p.run('routePlayer.route.revision=2;routePlayer.route.id="other-route"');
  const replay=p.run('startTourNarration(true)');assert.deepEqual(p.requests[1].body,p.requests[0].body);
  p.resolve(1,'/eleven.mp3',true);await replay;assert.equal(p.audio.src,'/eleven.mp3');
});

function researchedNarrator(){
  const p=narrator(null);
  p.c.currentSurvey='2mass';p.c.tourSkySurvey=()=>p.c.currentSurvey;
  p.c.esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  p.c.storySourcesMarkup=()=>'<details>Story sources</details>';
  p.c.narrationFor=(m,s)=>m?.narration||s?.guide?.narration||'';
  p.c.pauseRoute=()=>{p.c.routePlayer.playing=false;p.calls.push('route-paused');};
  p.run('routePlayer.route.media[0]={kind:"mast",title:"M-16",description:"JWST Cycle 1 Outreach Campaign"};routePlayer.route.stops[0]={title:"M-16",ra:274.73,dec:-13.85,fov:.2,source:{kind:"mast",id:"123"}}');
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/tour-stories.js'),'utf8'),p.c);
  return p;
}
function story(survey='2mass'){
  const narration='The Eagle Nebula is a stellar nursery in Serpens. Young stars sculpt its dense clouds of gas and dust.';
  const url='https://science.nasa.gov/eagle-nebula';
  return {narration,context:{survey},story:{title:'The Eagle Nebula',paragraphs:[{text:narration,source_urls:[url]}]},sources:[{url,title:'NASA'}],cached:true};
}

test('archive codes are researched before ElevenLabs receives plain sentences, with clickable sources separate',async()=>{
  const p=researchedNarrator(),pending=p.run('startTourNarration()');
  assert.equal(p.requests.length,1);assert.equal(p.requests[0].url,'/api/navigation/stories');
  assert.equal(p.requests[0].body.stop.survey,'2mass');assert.equal(p.run('tourNarrationPending()'),true);
  p.requests[0].resolve(story());await settle();
  assert.equal(p.requests[1].url,'/api/narration/elevenlabs/clip');
  assert.deepEqual(p.requests[1].body,{text:story().narration});
  assert.doesNotMatch(p.requests[1].body.text,/Campaign|https:|\[1\]/);
  assert.match(p.$('#route-stop-description').innerHTML,/href="https:\/\/science.nasa.gov/);
  p.resolve(1,'/saved-eagle.mp3',true);await pending;
  await p.run('startTourNarration()');assert.equal(p.requests.length,2);
  p.audio.finish();const replay=p.run('startTourNarration(true)');
  assert.equal(p.requests.length,3);assert.equal(p.requests[2].url,'/api/narration/elevenlabs/clip');
  p.resolve(2,'/saved-eagle.mp3',true);await replay;
});

test('research failure pauses the tour and never narrates metadata or automatically retries',async()=>{
  const p=researchedNarrator(),pending=p.run('startTourNarration()');
  p.requests[0].reject(new Error('OpenAI unavailable'));await pending;
  assert.equal(p.requests.length,1);assert.equal(p.audio.src,'');assert.ok(p.calls.includes('route-paused'));
  await p.run('startTourNarration()');assert.equal(p.requests.length,1);
  const replay=p.run('startTourNarration(true)');assert.equal(p.requests[1].body.retry,true);
  p.requests[1].resolve(story());await settle();p.resolve(2,'/eagle.mp3',true);await replay;
});

test('late research from a different stop or sky survey cannot replace the current story or start paid speech',async()=>{
  const p=researchedNarrator(),first=p.run('startTourNarration()');
  p.c.currentSurvey='hydrogen';p.run('refreshTourStoryForSurvey()');
  assert.equal(p.requests.length,2);assert.equal(p.requests[1].body.stop.survey,'hydrogen');
  p.requests[0].resolve(story());await first;assert.equal(p.requests.length,2);assert.equal(p.run('tourNarration.pending'),true);
  p.run('routePlayer.index=1;resetTourNarration()');
  p.requests[1].resolve(story('hydrogen'));await settle();
  assert.equal(p.requests.length,2);assert.equal(p.audio.src,'');
});

test('browser voice also waits for researched sentences instead of reading archive titles',async()=>{
  const p=researchedNarrator();p.$('#tour-narration-provider').value='browser';
  const pending=p.run('startTourNarration()');assert.equal(p.spoken.length,0);
  p.requests[0].resolve(story());await pending;
  assert.equal(p.spoken.length,1);assert.equal(p.spoken[0].text,story().narration);
});

test('Notebook scripts remain exact and skip OpenAI research',async()=>{
  const p=researchedNarrator();p.run('routePlayer.route.stops[0].guide={narration:"My own narration.",edited:true}');
  const pending=p.run('startTourNarration()');assert.equal(p.requests[0].url,'/api/narration/elevenlabs/clip');
  assert.equal(p.requests[0].body.text,'My own narration.');p.resolve();await pending;
});
