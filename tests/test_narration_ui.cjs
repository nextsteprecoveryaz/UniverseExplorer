const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/narration.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

function narrator(){
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
  const c=vm.createContext({$,console,window:{speechSynthesis:speech},document:{createElement:node},
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
  assert.match(p.$('#tour-narration-status').textContent,/Preparing OpenAI/);
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
