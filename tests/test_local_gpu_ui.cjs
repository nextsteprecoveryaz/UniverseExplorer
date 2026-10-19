const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../static/local-gpu.js'),'utf8');
function harness(){
  const nodes=new Map(),requests=[],saved=new Map(),rendered=[],messages=[];
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,textContent:''});return nodes.get(id);};
  for(const [key,value] of Object.entries({'enhancement-provider':'gpu','gpu-model':'realesrnet','gpu-scale':'2','gpu-strength':'80','gpu-tile':'512','gpu-precision':'fp16','fits-stretch':'log'}))$('#'+key).value=value;
  const state={image:{id:'original',width:100,height:60}},context=vm.createContext({$,state,enhancementRunning:false,
    api:async url=>{requests.push({url});if(url.includes('/jobs/'))return {status:'completed',image_id:'original',progress:100,message:'Saved',result:{variant:'new'}};return {id:'original',local_history:[{variant:'new'}]};},
    jsonPost:async(url,body)=>{requests.push({url,body});return {id:'job'};},
    localStorage:{setItem:(k,v)=>saved.set(k,v),getItem:k=>saved.get(k),removeItem:k=>saved.delete(k)},
    updateEnhancementControls:()=>context.updateLocalGPUControls(),renderEnhancementComparison:id=>rendered.push(id),toast:m=>messages.push(m),failure:e=>messages.push(e.message),setTimeout,
  });vm.runInContext(script,context);vm.runInContext('localGPU.runtime={ready:true}',context);
  return {$,context,state,requests,saved,rendered,messages,run:s=>vm.runInContext(s,context)};
}
test('GPU run freezes settings, polls a job, saves history, and releases controls',async()=>{
  const h=harness();await h.context.runLocalGPUEnhancement();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0])),{url:'/api/local-gpu/images/original',body:{model:'realesrnet',scale:2,strength:.8,tile:512,precision:'fp16',stretch:'log'}});
  assert.deepEqual(h.requests.slice(1).map(v=>v.url),['/api/local-gpu/jobs/job','/api/images/original']);
  assert.deepEqual(h.rendered,['new']);assert.equal(h.saved.size,0);assert.equal(h.run('enhancementRunning'),false);assert.equal(h.$('#enhance-button').disabled,false);
});
test('a result cannot replace another image opened during enhancement',async()=>{
  const h=harness();h.context.jsonPost=async(url,body)=>{h.state.image={id:'another',width:100,height:60};return {id:'job'};};
  await h.context.runLocalGPUEnhancement();assert.equal(h.state.image.id,'another');assert.deepEqual(h.rendered,[]);
});
test('failed jobs release controls and remove saved polling state',async()=>{
  const h=harness();h.context.api=async()=>({status:'failed',progress:20,message:'GPU memory is busy'});
  await assert.rejects(h.context.runLocalGPUEnhancement(),/GPU memory/);
  assert.equal(h.run('enhancementRunning'),false);assert.equal(h.$('#enhancement-provider').disabled,false);assert.equal(h.saved.size,0);
});
test('network failure keeps the job reference for reconnect without resubmitting',async()=>{
  const h=harness();h.context.api=async()=>{throw Error('Offline');};
  await assert.rejects(h.context.runLocalGPUEnhancement(),/Offline/);assert.equal(h.saved.get('universe:gpu-job'),'job');assert.equal(h.requests.length,1);
});
test('invalid settings and oversized outputs never start a job',async()=>{
  const h=harness();h.$('#gpu-scale').value='9';await assert.rejects(h.context.runLocalGPUEnhancement(),/valid local/);
  h.$('#gpu-scale').value='4';h.state.image.width=4000;h.state.image.height=4000;await assert.rejects(h.context.runLocalGPUEnhancement(),/64 megapixels/);assert.equal(h.requests.length,0);
});
test('missing GPU installation disables upscale instead of silently using the CPU',async()=>{
  const h=harness();h.run('localGPU.runtime={ready:false}');h.context.updateLocalGPUControls();assert.equal(h.$('#enhance-button').disabled,true);
  await assert.rejects(h.context.runLocalGPUEnhancement(),/Setup-GPU/);assert.equal(h.requests.length,0);
});
