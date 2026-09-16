const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/features.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const catalog={default_model:'Standard V2',max_output_pixels:25000000,models:[
  {id:'Standard V2',label:'Standard V2',family:'Precision',description:'General-purpose precision upscale.',parameters:[
    {key:'sharpen',label:'Sharpen',type:'number',min:0,max:1,step:.01,default:null},
    {key:'denoise',label:'Denoise',type:'number',min:0,max:1,step:.01,default:null},
  ]},
  {id:'High Fidelity V2',label:'High Fidelity V2',family:'Precision',description:'Preserve detailed images.',parameters:[]},
  {id:'Upscale High Fidelity V3',label:'High Fidelity V3',family:'Precision',description:'Detail recovery.',parameters:[
    {key:'recoveryStrength',label:'Recovery strength',type:'number',min:0,max:1,step:.01,default:1},
    {key:'opacity',label:'Opacity',type:'number',min:0,max:1,step:.01,default:1},
  ]},
  {id:'Bloom 2',label:'Bloom 2',family:'Creative',description:'Creative detail.',source_url:'https://developer.topazlabs.com/bloom',parameters:[
    {key:'creativity',label:'Creativity',type:'integer',min:1,max:9,step:1,default:3},
    {key:'colorPreservation',label:'Preserve colors',type:'boolean',default:true},
    {key:'prompt',label:'Prompt',type:'text',max_length:1024,default:''},
    {key:'grain',label:'Grain',type:'boolean',default:false},
  ]},
  {id:'Wonder 3.5',label:'Wonder 3.5',family:'Generative',description:'Reconstruct details.',parameters:[
    {key:'enhancementStrength',label:'Enhancement strength',type:'enum',options:['low','medium','high'],default:'medium'},
    {key:'grain',label:'Grain',type:'boolean',default:false},
  ]},
  {id:'Recover 3',label:'Recover 3',family:'Generative',description:'Recover degraded images.',parameters:[
    {key:'enhancementStrength',label:'Enhancement strength',type:'number',min:0,max:10,step:.1,default:5},
    {key:'creativity',label:'Creativity',type:'integer',min:1,max:9,step:1,default:3},
    {key:'texture',label:'Texture',type:'integer',min:1,max:5,step:1,default:1},
    {key:'prompt',label:'Prompt',type:'text',max_length:1024,default:''},
  ]},
]};

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
  c.catalog=catalog;run('installTopazModels(catalog)');
  const choose=model=>{$('#topaz-model').value=model;run('renderTopazModel()');};
  const connect=()=>run("topazConnection={configured:true,model:'Standard V2',storage:'encrypted Windows account',max_output_pixels:25000000}");
  const result=(id='first')=>({id,width:400,height:300,scientific:false,cloud_ai:{variant:'topaz-1'},cloud_history:[{
    variant:'topaz-1',provider:'Topaz cloud',model:'Standard V2',scale:2,url:'/topaz.png',note:'AI visualization. Original preserved.',input_size:[400,300],output_size:[800,600],created_at:'today',
  }]});
  return {$,state,c,run,choose,connect,result,requests,errors,messages,modals,refreshes};
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
  assert.deepEqual(JSON.parse(h.requests[0].options.body),{scale:4,stretch:'log',model:'Standard V2',parameters:{}});
  assert.equal(h.requests[0].options.method,'POST');assert.ok(h.requests[0].options.signal instanceof AbortSignal);
  for(const id of ['#enhance-button','#enhancement-provider','#topaz-scale','#topaz-connect','#topaz-model','#topaz-parameter-0-auto'])assert.equal(h.$(id).disabled,true);
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
  for(const id of ['#enhance-button','#enhancement-provider','#topaz-scale','#topaz-connect','#topaz-model','#topaz-parameter-0-auto'])assert.equal(h.$(id).disabled,false);
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
  assert.match(h.$('#ai-output-select').innerHTML,/Topaz cloud · Standard V2 · 2×/);
});

test('a provider change during processing is retained when the result arrives',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';const pending=h.run('runEnhancement()');
  h.$('#enhancement-provider').value='local';h.requests[0].resolve(h.result());await pending;
  assert.equal(h.$('#enhancement-provider').value,'local');assert.equal(h.$('#topaz-settings').hidden,true);
  assert.match(h.$('#enhance-button').textContent,/locally/);assert.equal(h.requests.length,1);
});

test('initialization checks connection status without uploading an image or starting an upscale',async()=>{
  const h=harness();h.run('initObservatoryFeatures()');
  assert.deepEqual(h.requests.map(request=>request.url),['/api/objects/featured','/api/cloud/status','/api/topaz/status','/api/topaz/models']);
  const status=h.requests.find(request=>request.url==='/api/topaz/status');status.resolve({configured:true,model:'Standard V2',storage:'encrypted Windows account'});
  await Promise.resolve();await Promise.resolve();
  assert.match(h.$('#topaz-connection').textContent,/Connected/);assert.equal(h.$('#enhancement-provider').value,'local');
  assert.equal(typeof h.$('#topaz-connect').onclick,'function');assert.equal(typeof h.$('#topaz-scale').onchange,'function');
  assert.equal(h.requests.length,4);
});

test('the catalog exposes all six models and labels creative output without changing the precision default',()=>{
  const h=harness();assert.equal(h.$('#topaz-model').value,'Standard V2');
  for(const model of catalog.models)assert.ok(h.$('#topaz-model').innerHTML.includes(model.id));
  h.choose('Bloom 2');assert.match(h.$('#topaz-model-description').innerHTML,/Creative visualization.*invent structures/);
  assert.match(h.$('#topaz-model-description').innerHTML,/https:\/\/developer\.topazlabs\.com\/bloom/);
  assert.equal(h.$('#topaz-parameter-0').value,3);assert.equal(h.$('#topaz-parameter-1').checked,true);
  assert.match(h.$('#topaz-model-parameters').innerHTML,/type="range" min="1" max="9" step="1"/);
  assert.match(h.$('#topaz-model-parameters').innerHTML,/maxlength="1024"/);assert.equal(h.requests.length,0);
});

test('Auto omits optional parameters and explicit numeric settings survive model switches',()=>{
  const h=harness();assert.deepEqual(plain(h.run('topazRequestSnapshot()')),{model:'Standard V2',parameters:{}});
  assert.equal(h.$('#topaz-parameter-0').disabled,true);
  h.$('#topaz-parameter-0-auto').checked=false;h.$('#topaz-parameter-0-auto').onchange();
  assert.equal(h.$('#topaz-parameter-0').disabled,false);
  h.$('#topaz-parameter-0-range').value='.37';h.$('#topaz-parameter-0-range').oninput();
  assert.equal(h.$('#topaz-parameter-0').value,'.37');
  assert.deepEqual(plain(h.run('topazRequestSnapshot()')),{model:'Standard V2',parameters:{sharpen:.37}});
  h.choose('Bloom 2');h.$('#topaz-parameter-0').value='7';h.$('#topaz-parameter-0').oninput();
  h.choose('Standard V2');assert.equal(h.$('#topaz-parameter-0-auto').checked,false);assert.equal(Number(h.$('#topaz-parameter-0').value),.37);
  h.choose('Bloom 2');assert.equal(Number(h.$('#topaz-parameter-0').value),7);
  h.choose('Standard V2');h.$('#topaz-parameter-0-auto').checked=true;h.$('#topaz-parameter-0-auto').onchange();
  assert.deepEqual(plain(h.run('topazRequestSnapshot()')).parameters,{});assert.equal(h.$('#topaz-parameter-0-range').disabled,true);
});

test('Bloom requests snapshot the selected controls and cannot acquire later UI edits',async()=>{
  const h=harness();h.connect();h.choose('Bloom 2');h.$('#enhancement-provider').value='topaz';
  h.$('#topaz-parameter-0').value='8';h.$('#topaz-parameter-0').oninput();
  h.$('#topaz-parameter-1').checked=false;h.$('#topaz-parameter-1').onchange();
  h.$('#topaz-parameter-2').value='Keep the diffuse star colors.';h.$('#topaz-parameter-2').oninput();
  h.$('#topaz-parameter-3').checked=true;h.$('#topaz-parameter-3').onchange();
  const pending=h.run('runEnhancement()');
  const expected={scale:2,stretch:'asinh',model:'Bloom 2',parameters:{creativity:8,colorPreservation:false,prompt:'Keep the diffuse star colors.',grain:true}};
  assert.deepEqual(JSON.parse(h.requests[0].options.body),expected);
  for(let i=0;i<4;i++)assert.equal(h.$('#topaz-parameter-'+i).disabled,true);
  assert.equal(h.$('#topaz-parameter-0-range').disabled,true);
  h.$('#topaz-parameter-2').value='A later edit';h.$('#topaz-parameter-2').oninput();
  assert.deepEqual(JSON.parse(h.requests[0].options.body),expected);
  const result=h.result();result.cloud_history[0].model='Bloom 2';h.requests[0].resolve(result);await pending;
  assert.match(h.$('#ai-output-select').innerHTML,/Topaz cloud · Bloom 2 · 2×/);
  assert.equal(h.$('#topaz-parameter-2').disabled,false);assert.equal(h.$('#topaz-model').disabled,false);
});

test('Wonder enum and Recover numeric controls only contribute their own supported parameters',()=>{
  const h=harness();h.choose('Wonder 3.5');h.$('#topaz-parameter-0').value='high';h.$('#topaz-parameter-0').onchange();
  assert.deepEqual(plain(h.run('topazRequestSnapshot()')),{model:'Wonder 3.5',parameters:{enhancementStrength:'high',grain:false}});
  h.choose('Recover 3');h.$('#topaz-parameter-0').value='7.4';h.$('#topaz-parameter-0').oninput();
  assert.deepEqual(plain(h.run('topazRequestSnapshot()')),{model:'Recover 3',parameters:{enhancementStrength:7.4,creativity:3,texture:1,prompt:''}});
  h.choose('Upscale High Fidelity V3');
  assert.deepEqual(plain(h.run('topazRequestSnapshot()')),{model:'Upscale High Fidelity V3',parameters:{recoveryStrength:1,opacity:1}});
});

test('out-of-range, fractional integer, and overlong prompt values never submit an upscale',async()=>{
  const h=harness();h.connect();h.choose('Bloom 2');h.$('#enhancement-provider').value='topaz';
  for(const value of ['10','2.5','']){
    h.$('#topaz-parameter-0').value=value;h.$('#topaz-parameter-0').oninput();
    await assert.rejects(h.run('runEnhancement()'),/supported value for Creativity/);
  }
  h.$('#topaz-parameter-0').value='3';h.$('#topaz-parameter-0').oninput();
  h.$('#topaz-parameter-2').value='x'.repeat(1025);h.$('#topaz-parameter-2').oninput();
  await assert.rejects(h.run('runEnhancement()'),/supported value for Prompt/);
  h.choose('Wonder 3.5');h.$('#topaz-parameter-0').value='unsupported';h.$('#topaz-parameter-0').onchange();
  await assert.rejects(h.run('runEnhancement()'),/supported value for Enhancement strength/);
  assert.equal(h.requests.length,0);assert.equal(h.run('enhancementRunning'),false);
});

test('unknown model selections fail before submission instead of silently falling back',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';h.$('#topaz-model').value='Unavailable model';
  await assert.rejects(h.run('runEnhancement()'),/Choose an available Topaz model/);assert.equal(h.requests.length,0);
});

test('catalog loading blocks only Topaz and failure explicitly exposes the precision fallback',async()=>{
  const h=harness();h.connect();h.$('#enhancement-provider').value='topaz';const pending=h.run('loadTopazModels()');
  assert.equal(h.$('#enhance-button').disabled,true);assert.equal(h.$('#topaz-model').disabled,true);
  await assert.rejects(h.run('runEnhancement()'),/Wait for the Topaz models/);assert.equal(h.requests.length,1);
  h.$('#enhancement-provider').value='local';h.run('updateEnhancementControls()');assert.equal(h.$('#enhance-button').disabled,false);
  h.requests[0].reject(new Error('Unavailable'));await pending;
  assert.equal(h.$('#topaz-model').value,'Standard V2');assert.match(h.$('#topaz-model-status').textContent,/unavailable.*automatic settings.*Reload/);
  assert.deepEqual(plain(h.run('topazRequestSnapshot()')),{model:'Standard V2',parameters:{}});
  assert.equal(h.requests.length,1);assert.equal(h.$('#topaz-model').disabled,false);
});

test('malformed catalogs produce the explicit fallback without empty or unknown model controls',async()=>{
  const h=harness();const pending=h.run('loadTopazModels()');h.requests[0].resolve({models:[]});await pending;
  assert.equal(h.$('#topaz-model').value,'Standard V2');assert.match(h.$('#topaz-model-status').textContent,/unavailable/);
  assert.match(h.$('#topaz-model-parameters').innerHTML,/automatic settings/);assert.equal(h.requests.length,1);
});

test('a failed creative-model job restores all controls without losing its chosen settings',async()=>{
  const h=harness();h.connect();h.choose('Bloom 2');h.$('#enhancement-provider').value='topaz';
  h.$('#topaz-parameter-0-range').value='9';h.$('#topaz-parameter-0-range').oninput();const pending=h.run('runEnhancement()');
  h.requests[0].reject(new Error('The job is saved; check again with the same settings.'));await pending;
  assert.equal(h.$('#topaz-model').value,'Bloom 2');assert.equal(h.$('#topaz-model').disabled,false);
  for(let i=0;i<4;i++)assert.equal(h.$('#topaz-parameter-'+i).disabled,false);
  assert.equal(h.run('topazRequestSnapshot().parameters.creativity'),9);assert.equal(h.requests.length,1);
});
