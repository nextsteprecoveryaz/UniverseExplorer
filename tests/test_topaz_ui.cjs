const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/features.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));

function harness(){
  const nodes=new Map(),requests=[],errors=[],messages=[],modals=[],refreshes=[];
  const node=()=>({value:'',checked:false,disabled:false,hidden:false,textContent:'',src:'',href:'',
    classList:{toggle(){}},
    set innerHTML(value){this.html=value;const first=String(value).match(/<option value="([^"]*)"/);if(first)this.value=first[1];},
    get innerHTML(){return this.html||'';},
  });
  const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  $('#enhancement-provider').value='local';$('#topaz-scale').value='2';$('#fits-stretch').value='asinh';
  $('#cloud-quality').value='medium';$('#cloud-instructions').value='Preserve the star field.';
  $('#original-image').src='/original.png';$('#original-download').href='/original.png?download=true';
  const state={image:{id:'first',width:400,height:300,scientific:false,cloud_history:[]},page:'lab'};
  const api=(url,options={})=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
  const c=vm.createContext({$, $$:()=>[],state,console,AbortSignal,
    api,jsonPost:(url,body)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
    esc:value=>String(value??''),date:value=>value,
    modal:(title,html)=>modals.push({title,html}),closeModal:()=>messages.push('modal closed'),
    toast:text=>messages.push(text),failure:error=>errors.push(error),
    busy:async(button,label,action)=>{
      if(button.disabled)return;
      const text=button.textContent;button.disabled=true;button.textContent=label;
      try{return await action();}catch(error){errors.push(error);}finally{button.disabled=false;button.textContent=text;}
    },
    refreshImageLabColors:()=>refreshes.push({src:$('#ai-image').src,hidden:$('#ai-image').hidden}),
    window:{addEventListener(){}},ResizeObserver:class{observe(){}},setInterval(){},
    document:{hidden:false},localStorage:{getItem(){return null;}},
  });
  vm.runInContext(source,c);
  const run=code=>vm.runInContext(code,c);
  const connect=()=>run("topazConnection={configured:true,model:'Standard V2',storage:'encrypted Windows account',max_output_pixels:25000000}");
  const result=(id='first')=>({id,width:400,height:300,scientific:false,cloud_ai:{variant:'topaz-1'},cloud_history:[{
    variant:'topaz-1',provider:'Topaz cloud',model:'Standard V2',scale:2,url:'/topaz.png',note:'AI visualization. Original preserved.',input_size:[400,300],output_size:[800,600],created_at:'today',
  }]});
  return {$,state,c,run,connect,result,requests,errors,messages,modals,refreshes};
}

test('Topaz is an explicit provider and displays upload and credit information',()=>{
  const h=harness();h.run('updateEnhancementControls()');
  assert.equal(h.$('#enhancement-provider').value,'local');assert.equal(h.$('#topaz-settings').hidden,true);
  h.$('#enhancement-provider').value='topaz';h.$('#topaz-scale').value='4';h.run('updateEnhancementControls()');
  assert.equal(h.$('#topaz-settings').hidden,false);assert.equal(h.$('#cloud-options').hidden,true);
  assert.match(h.$('#enhance-button').textContent,/Topaz.*4×/);
  assert.match(h.$('#topaz-note').textContent,/to Topaz when you click Upscale.*API credits/);
  assert.match(h.$('#topaz-note').textContent,/1600 × 1200/);assert.equal(h.requests.length,0);
});

test('one explicit upscale sends its scale and FITS stretch and displays the separate result',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';h.$('#topaz-scale').value='4';h.$('#fits-stretch').value='log';
  const pending=h.run('runEnhancement()');
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/images/first/enhance-topaz');
  assert.deepEqual(JSON.parse(h.requests[0].options.body),{scale:4,stretch:'log'});
  assert.equal(h.requests[0].options.method,'POST');assert.ok(h.requests[0].options.signal instanceof AbortSignal);
  for(const id of ['#enhance-button','#enhancement-provider','#topaz-scale','#topaz-connect'])assert.equal(h.$(id).disabled,true);
  await h.run('runEnhancement()');assert.equal(h.requests.length,1);
  h.requests[0].resolve(h.result());await pending;
  assert.equal(h.$('#ai-output-select').value,'topaz-1');assert.match(h.$('#ai-image').src,/^\/topaz\.png\?v=/);
  assert.equal(h.$('#original-image').src,'/original.png');assert.equal(h.$('#original-download').href,'/original.png?download=true');
  assert.equal(h.refreshes.length,1);assert.equal(h.refreshes[0].src,h.$('#ai-image').src);assert.equal(h.refreshes[0].hidden,false);
  assert.equal(h.run('enhancementRunning'),false);assert.equal(h.$('#topaz-scale').disabled,false);
  assert.match(h.$('#image-provenance').textContent,/Topaz cloud/);assert.equal(h.errors.length,0);
});

test('a completed upscale cannot replace an image opened while it was processing',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';const pending=h.run('runEnhancement()');
  const next={id:'second',width:200,height:100};h.state.image=next;h.$('#original-image').src='/second.png';
  h.requests[0].resolve(h.result());await pending;
  assert.equal(h.state.image,next);assert.equal(h.$('#original-image').src,'/second.png');assert.equal(h.$('#ai-image').src,'');
  assert.equal(h.refreshes.length,0);assert.match(h.messages.at(-1),/original image in your library/);
  assert.equal(h.$('#enhancement-provider').disabled,false);assert.equal(h.run('enhancementRunning'),false);
});

test('a Topaz failure releases every busy control and permits an explicit retry',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';const pending=h.run('runEnhancement()');
  h.requests[0].reject(new Error('Topaz could not process this image.'));await pending;
  assert.equal(h.errors.length,1);assert.match(h.errors[0].message,/could not process/);
  assert.equal(h.state.image.id,'first');assert.equal(h.refreshes.length,0);
  for(const id of ['#enhance-button','#enhancement-provider','#topaz-scale','#topaz-connect'])assert.equal(h.$(id).disabled,false);
  const retry=h.run('runEnhancement()');assert.equal(h.requests.length,2);h.requests[1].resolve(h.result());await retry;
  assert.equal(h.$('#ai-output-select').value,'topaz-1');
});

test('connecting clears the password field and never starts a paid upscale automatically',async()=>{
  const h=harness();h.$('#enhancement-provider').value='topaz';const pending=h.run('runEnhancement()');
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/topaz/status');
  h.requests[0].resolve({configured:false,model:'Standard V2'});await pending;
  assert.match(h.modals[0].html,/type="password"/);assert.match(h.modals[0].html,/Connecting does not start an upscale/);
  h.$('#topaz-api-key').value='  test-secret-key  ';h.$('#topaz-remember').checked=true;
  const save=h.$('#topaz-key-form').onsubmit({preventDefault(){}});
  assert.equal(h.$('#topaz-api-key').value,'');assert.equal(h.requests[1].url,'/api/topaz/connect');
  assert.deepEqual(JSON.parse(h.requests[1].options.body),{api_key:'test-secret-key',remember:true});
  h.requests[1].resolve({configured:true,model:'Standard V2',storage:'encrypted Windows account'});await save;
  assert.equal(h.requests.length,2);assert.match(h.$('#topaz-connection').textContent,/Connected/);
  assert.equal(h.run('topazConnection.configured'),true);assert.equal(h.$('#topaz-key-save').disabled,false);
  assert.ok(h.messages.every(message=>!message.includes('test-secret-key')));
});

test('connection failures leave no key in the field and allow retry without an upscale',async()=>{
  const h=harness();const opening=h.run('openTopazConnection()');h.requests[0].resolve({configured:false});await opening;
  h.$('#topaz-api-key').value='test-invalid-key';const save=h.$('#topaz-key-form').onsubmit({preventDefault(){}});
  h.requests[1].reject(new Error('Topaz rejected this API key.'));await save;
  assert.equal(h.$('#topaz-api-key').value,'');assert.equal(h.$('#topaz-key-save').disabled,false);
  assert.equal(h.run('topazConnection.configured'),false);assert.equal(h.requests.length,2);assert.equal(h.errors.length,1);
});

test('invalid scale values are rejected before an upscale request',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';h.$('#topaz-scale').value='8';
  await assert.rejects(h.run('runEnhancement()'),/Choose a Topaz scale/);
  assert.equal(h.requests.length,0);assert.equal(h.run('enhancementRunning'),false);
});

test('local enhancement retains its existing endpoint and remains the default',async()=>{
  const h=harness();const pending=h.run('runEnhancement()');
  assert.equal(h.requests[0].url,'/api/images/first/enhance');assert.deepEqual(plain(h.requests[0].options),{method:'POST'});
  h.requests[0].resolve({...h.state.image,ai:{url:'/local.png',note:'Local visualization.',input_size:[400,300],output_size:[800,600]}});await pending;
  assert.equal(h.$('#ai-output-select').value,'local');assert.match(h.$('#enhance-button').textContent,/locally/);
});

test('OpenAI requests and earlier enhancements remain available alongside Topaz',async()=>{
  const h=harness();h.run('cloudConnection.configured=true');h.$('#enhancement-provider').value='cloud';
  const pending=h.run('runEnhancement()');assert.equal(h.requests[0].url,'/api/images/first/enhance-cloud');
  assert.deepEqual(JSON.parse(h.requests[0].options.body),{quality:'medium',instructions:'Preserve the star field.',stretch:'asinh'});
  h.requests[0].resolve(h.result());await pending;
  assert.equal(h.$('#enhancement-provider').value,'cloud');assert.equal(h.$('#topaz-settings').hidden,true);
  assert.match(h.$('#ai-output-select').innerHTML,/Topaz cloud · 2×/);
});

test('a provider change during processing is retained when the result arrives',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';const pending=h.run('runEnhancement()');
  h.$('#enhancement-provider').value='local';h.requests[0].resolve(h.result());await pending;
  assert.equal(h.$('#enhancement-provider').value,'local');assert.equal(h.$('#topaz-settings').hidden,true);
  assert.match(h.$('#enhance-button').textContent,/locally/);assert.equal(h.requests.length,1);
});

test('initialization checks connection status without uploading an image or starting an upscale',async()=>{
  const h=harness();h.run('initObservatoryFeatures()');
  assert.deepEqual(h.requests.map(request=>request.url),['/api/objects/featured','/api/cloud/status','/api/topaz/status']);
  const status=h.requests.find(request=>request.url==='/api/topaz/status');status.resolve({configured:true,model:'Standard V2',storage:'encrypted Windows account'});
  await Promise.resolve();await Promise.resolve();
  assert.match(h.$('#topaz-connection').textContent,/Connected/);assert.equal(h.$('#enhancement-provider').value,'local');
  assert.equal(typeof h.$('#topaz-connect').onclick,'function');assert.equal(typeof h.$('#topaz-scale').onchange,'function');
  assert.equal(h.requests.length,3);
});
