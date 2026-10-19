'use strict';

// Local FSRCNN inference. No external runtime, model downloads, or image uploads.
const LiveEnhancementMath={
  mode:value=>['off','fast','ai','auto'].includes(value)?value:'off',
  plan(width,height,tile=192,halo=6){
    const tiles=[];
    for(let y=0;y<height;y+=tile)for(let x=0;x<width;x+=tile){
      const left=Math.max(0,x-halo),top=Math.max(0,y-halo);
      tiles.push([Math.min(width,x+tile+halo)-left,Math.min(height,y+tile+halo)-top,
        x,y,x-left,y-top,Math.min(tile,width-x),Math.min(tile,height-y)]);
    }
    return tiles;
  },
  eligible({mode,moving,loading,hidden,elapsed}){return (mode==='ai'||mode==='auto')&&!moving&&!loading&&!hidden&&elapsed>=(mode==='ai'?200:750);},
};

class EnhancementCache{
  constructor(limit=256*1024*1024){this.limit=limit;this.bytes=0;this.items=new Map();}
  get(key){const item=this.items.get(key);if(item){this.items.delete(key);this.items.set(key,item);}return item;}
  put(key,item){this.remove(key);if(item.bytes>this.limit)return false;while(this.bytes+item.bytes>this.limit)this.remove(this.items.keys().next().value);this.items.set(key,item);this.bytes+=item.bytes;return true;}
  remove(key){const item=this.items.get(key);if(item){this.items.delete(key);this.bytes-=item.bytes;item.texture.destroy();}}
  clear(){for(const key of [...this.items.keys()])this.remove(key);}
}

class LiveEnhancementGPU{
  static async create(canvas){
    if(!navigator.gpu)throw Error('WebGPU is unavailable. Use current Chrome or Edge with hardware acceleration enabled.');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter||adapter.info?.isFallbackAdapter)throw Error('A hardware WebGPU adapter is unavailable.');
    const device=await adapter.requestDevice({requiredLimits:{maxTextureDimension2D:adapter.limits.maxTextureDimension2D}});
    const engine=new LiveEnhancementGPU(device,canvas,adapter.info);
    try{await engine.init();return engine;}catch(error){engine.destroy();throw error;}
  }
  constructor(device,canvas,info){this.device=device;this.canvas=canvas;this.info=info;this.cache=new EnhancementCache();this.model=null;this.destroyed=false;}
  async init(){
    const d=this.device;this.context=this.canvas.getContext('webgpu');
    if(!this.context)throw Error('The browser could not create the GPU display.');
    this.format=navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({device:d,format:this.format,alphaMode:'premultiplied'});
    this.sampler=d.createSampler({magFilter:'linear',minFilter:'linear'});
    const module=d.createShaderModule({code:`
      struct V { @builtin(position) p:vec4f, @location(0) uv:vec2f }
      @vertex fn vs(@builtin(vertex_index) i:u32)->V {
        let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
        var o:V;o.p=vec4f(p[i],0,1);o.uv=vec2f((p[i].x+1)*.5,(1-p[i].y)*.5);return o;
      }
      @group(0) @binding(0) var image:texture_2d<f32>;
      @group(0) @binding(1) var sampling:sampler;
      @group(0) @binding(2) var<uniform> strength:vec4f;
      @fragment fn fs(v:V)->@location(0) vec4f {
        let step=1./vec2f(textureDimensions(image));let c=textureSample(image,sampling,v.uv);
        if(strength.x==0.){return c;}
        let a=textureSample(image,sampling,v.uv+vec2f(step.x,0)).rgb;
        let b=textureSample(image,sampling,v.uv-vec2f(step.x,0)).rgb;
        let e=textureSample(image,sampling,v.uv+vec2f(0,step.y)).rgb;
        let f=textureSample(image,sampling,v.uv-vec2f(0,step.y)).rgb;
        let low=min(c.rgb,min(min(a,b),min(e,f)));let high=max(c.rgb,max(max(a,b),max(e,f)));
        return vec4f(clamp(c.rgb+strength.x*(c.rgb-(a+b+e+f)*.25),low,high),c.a);
      }`});
    this.display=await d.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:this.format}]},primitive:{topology:'triangle-list'}});
    this.strength=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  }
  texture(width,height){return this.device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.STORAGE_BINDING});}
  copy(source){
    if(!this.input||this.input.width!==source.width||this.input.height!==source.height){this.input?.destroy();this.input=this.texture(source.width,source.height);}
    this.device.queue.copyExternalImageToTexture({source},{texture:this.input},[source.width,source.height]);return this.input;
  }
  draw(texture,sharpness=.5,context=this.context){
    const d=this.device;
    d.queue.writeBuffer(this.strength,0,new Float32Array([sharpness,0,0,0]));
    const group=d.createBindGroup({layout:this.display.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView()},{binding:1,resource:this.sampler},{binding:2,resource:{buffer:this.strength}}]});
    const encoder=d.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(this.display);pass.setBindGroup(0,group);pass.draw(3);pass.end();d.queue.submit([encoder.finish()]);
  }
  async capture(texture,sharpness){
    const canvas=document.createElement('canvas');canvas.width=texture.width;canvas.height=texture.height;
    const context=canvas.getContext('webgpu');context.configure({device:this.device,format:this.format,alphaMode:'premultiplied'});
    try{
      this.draw(texture,sharpness,context);await this.device.queue.onSubmittedWorkDone();
      const output=document.createElement('canvas');output.width=canvas.width;output.height=canvas.height;output.getContext('2d').drawImage(canvas,0,0);return output;
    }finally{context.unconfigure();}
  }
  async loadModel(){
    if(this.readyModel)return;
    const response=await fetch('/api/live-enhancement/model');
    if(!response.ok){const body=await response.json();throw Error(body.detail||'Local neural model unavailable.');}
    const model=await response.json(),d=this.device;
    if(model.schema!==1||model.layers.length!==8||model.scale!==2)throw Error('Unexpected neural model format.');
    this.model=model;this.parameters=d.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const size=(192+2*model.halo)**2*56*4;
    this.buffers=[0,1].map(()=>d.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}));
    const params='struct Params { w:u32,h:u32,x:u32,y:u32,cx:u32,cy:u32,ow:u32,oh:u32 }\n@group(0) @binding(0) var<uniform> p:Params;';
    this.prepare=await d.createComputePipelineAsync({layout:'auto',compute:{entryPoint:'main',module:d.createShaderModule({code:params+`
      @group(0) @binding(1) var source:texture_2d<f32>;
      @group(0) @binding(2) var<storage,read_write> dest:array<f32>;
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
        if(id.x>=p.w||id.y>=p.h){return;}
        let rgb=textureLoad(source,vec2i(id.xy+vec2u(p.x-p.cx,p.y-p.cy)),0).rgb;
        dest[id.y*p.w+id.x]=dot(rgb,vec3f(.299,.587,.114));
      }`})}});
    this.layers=[];
    for(const layer of model.layers){
      const values=new Float32Array([...layer.weights,...layer.bias,...layer.alpha]);
      const weights=d.createBuffer({size:values.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(weights,0,values);
      const {inputs:ic,outputs:oc,kernel:k}=layer,offset=layer.weights.length;
      const pipeline=await d.createComputePipelineAsync({layout:'auto',compute:{entryPoint:'main',module:d.createShaderModule({code:params+`
        @group(0) @binding(1) var<storage,read> input:array<f32>;
        @group(0) @binding(2) var<storage,read_write> output:array<f32>;
        @group(0) @binding(3) var<storage,read> weights:array<f32>;
        @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
          if(id.x>=p.w||id.y>=p.h||id.z>=${oc}u){return;}
          var sum=weights[${offset}u+id.z];
          for(var c=0u;c<${ic}u;c++) {for(var ky=0u;ky<${k}u;ky++){for(var kx=0u;kx<${k}u;kx++){
            let x=i32(id.x)+i32(kx)-${Math.floor(k/2)};let y=i32(id.y)+i32(ky)-${Math.floor(k/2)};
            if(x>=0&&y>=0&&x<i32(p.w)&&y<i32(p.h)){
              sum+=input[c*p.w*p.h+u32(y)*p.w+u32(x)]*weights[((id.z*${ic}u+c)*${k}u+ky)*${k}u+kx];
            }
          }}}
          output[id.z*p.w*p.h+id.y*p.w+id.x]=max(sum,0.)+weights[${offset+oc}u+id.z]*min(sum,0.);
        }`})}});
      this.layers.push({pipeline,weights,outputs:oc});
    }
    this.finish=await d.createComputePipelineAsync({layout:'auto',compute:{entryPoint:'main',module:d.createShaderModule({code:params+`
      @group(0) @binding(1) var<storage,read> input:array<f32>;
      @group(0) @binding(2) var source:texture_2d<f32>;
      @group(0) @binding(3) var sampling:sampler;
      @group(0) @binding(4) var output:texture_storage_2d<rgba8unorm,write>;
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
        if(id.x>=p.ow*2u||id.y>=p.oh*2u){return;}
        let xy=vec2u(p.x,p.y)*2u+id.xy;let uv=(vec2f(xy)+.5)/vec2f(textureDimensions(output));
        let original=textureSampleLevel(source,sampling,uv,0.);
        let channel=(id.y%2u)*2u+id.x%2u;
        let y=input[channel*p.w*p.h+(id.y/2u+p.cy)*p.w+id.x/2u+p.cx]+${model.output_bias};
        let difference=y-dot(original.rgb,vec3f(.299,.587,.114));
        textureStore(output,vec2i(xy),vec4f(clamp(original.rgb+vec3f(difference),vec3f(0),vec3f(1)),original.a));
      }`})}});
    this.readyModel=true;
  }
  group(pipeline,resources){return this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});}
  async upscale(source,current,progress=()=>{}){
    await this.loadModel();if(!current())return null;
    const d=this.device,w=source.width,h=source.height;
    if(w*2>d.limits.maxTextureDimension2D||h*2>d.limits.maxTextureDimension2D)throw Error('This map is too large for 2× output on this GPU. Reduce the window size.');
    const input=this.texture(w,h),output=this.texture(w*2,h*2);let done=false;
    d.queue.copyExternalImageToTexture({source},{texture:input},[w,h]);
    try{
      const plan=LiveEnhancementMath.plan(w,h,192,this.model.halo);
      for(let index=0;index<plan.length;index++){
        if(!current())return null;
        const tile=plan[index];d.queue.writeBuffer(this.parameters,0,new Uint32Array(tile));
        const encoder=d.createCommandEncoder();
        const dispatch=(pipeline,resources,x,y,z=1)=>{const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,this.group(pipeline,resources));pass.dispatchWorkgroups(Math.ceil(x/8),Math.ceil(y/8),z);pass.end();};
        const param={buffer:this.parameters};
        dispatch(this.prepare,[param,input.createView(),{buffer:this.buffers[0]}],tile[0],tile[1]);
        let active=0;
        for(const layer of this.layers){dispatch(layer.pipeline,[param,{buffer:this.buffers[active]},{buffer:this.buffers[1-active]},{buffer:layer.weights}],tile[0],tile[1],layer.outputs);active=1-active;}
        dispatch(this.finish,[param,{buffer:this.buffers[active]},input.createView(),this.sampler,output.createView()],tile[6]*2,tile[7]*2);
        d.queue.submit([encoder.finish()]);await d.queue.onSubmittedWorkDone();
        progress((index+1)/plan.length);
      }
      if(!current())return null;
      done=true;return {texture:output,width:w*2,height:h*2,bytes:w*h*16};
    }finally{input.destroy();if(!done)output.destroy();}
  }
  destroy(){this.destroyed=true;this.cache.clear();this.input?.destroy();this.device.destroy();}
}
if(typeof module!=='undefined')module.exports={LiveEnhancementMath,EnhancementCache};
