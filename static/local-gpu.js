'use strict';
const localGPU={runtime:null,job:null,watching:false};
function localGPUSettings(){
  const value={model:$('#gpu-model').value,scale:Number($('#gpu-scale').value),strength:Number($('#gpu-strength').value)/100,tile:Number($('#gpu-tile').value),precision:$('#gpu-precision').value,stretch:$('#fits-stretch').value};
  if(!['realesrnet','realesrgan'].includes(value.model)||![2,4].includes(value.scale)||!Number.isFinite(value.strength)||value.strength<0||value.strength>1||![128,256,512].includes(value.tile)||!['fp16','fp32'].includes(value.precision))throw Error('Choose valid local GPU enhancement settings.');
  return value;
}
function updateLocalGPUControls(){
  const active=$('#enhancement-provider').value==='gpu';$('#local-gpu-settings').hidden=!active;
  if(!active)return;
  $('#cloud-connect').hidden=true;
  if(!enhancementRunning)$('#enhance-button').textContent='✧ Upscale on GPU · '+$('#gpu-scale').value+'×';
  $('#enhance-button').disabled=enhancementRunning||!localGPU.runtime?.ready;
  const image=state.image,scale=Number($('#gpu-scale').value);
  $('#gpu-size').textContent=image?`${image.width} × ${image.height} source → ${image.width*scale} × ${image.height*scale} output. Full resolution; maximum 64 megapixels.`:'';
  $('#gpu-strength-value').textContent=$('#gpu-strength').value+'%';
  const detail=$('#gpu-model').value==='realesrgan';
  $('#gpu-model-note').textContent=detail?'Real-ESRGAN emphasizes texture and apparent detail. It can invent star-like points or change structures.':'Real-ESRNet uses a less aggressive restoration model. It can still smooth faint stars or change structures.';
  for(const id of ['model','scale','strength','tile','precision'])$('#gpu-'+id).disabled=enhancementRunning;
  $('#gpu-cancel').hidden=!localGPU.watching;$('#gpu-cancel').disabled=!localGPU.job||!localGPU.watching;
}
async function refreshLocalGPU(){
  const runtime=await api('/api/local-gpu/status');localGPU.runtime=runtime;
  $('#gpu-device').textContent=runtime.ready?`${runtime.device.gpu} · ${runtime.device.vram_gib} GiB VRAM · CUDA ${runtime.device.cuda} · ready`:'Local GPU engine unavailable. '+runtime.setup;
  updateEnhancementControls();
  let saved;try{saved=localStorage.getItem('universe:gpu-job');}catch{}
  const id=runtime.active_job||saved;if(id&&!localGPU.watching&&!enhancementRunning)watchLocalGPU(id).catch(failure);
}
function rememberGPUJob(id){try{id?localStorage.setItem('universe:gpu-job',id):localStorage.removeItem('universe:gpu-job');}catch{}}
async function watchLocalGPU(id){
  if(localGPU.watching)return;
  localGPU.job=id;localGPU.watching=true;enhancementRunning=true;$('#enhancement-provider').disabled=true;updateEnhancementControls();
  try{
    while(true){
      const job=await api('/api/local-gpu/jobs/'+id);
      $('#gpu-progress').value=job.progress;$('#gpu-job-status').textContent=`${job.progress}% · ${job.message}`;
      if(['completed','failed','cancelled'].includes(job.status)){
        rememberGPUJob(null);
        if(job.status==='completed'){
          const result=await api('/api/images/'+job.image_id);
          if(state.image?.id===job.image_id){state.image=result;renderEnhancementComparison(job.result.variant);$('#image-provenance').textContent=JSON.stringify(result,null,2);}
          toast('Local GPU enhancement saved. Original preserved.');
        }else if(job.status==='failed')throw Error(job.message);
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,700));
    }
  }catch(error){$('#gpu-job-status').textContent=error.message+' Use Refresh GPU status to reconnect if the job is still running.';throw error;}
  finally{localGPU.watching=false;enhancementRunning=false;$('#enhancement-provider').disabled=false;updateEnhancementControls();}
}
async function runLocalGPUEnhancement(){
  if(enhancementRunning||!state.image)return;
  if(!localGPU.runtime?.ready)throw Error('Run Setup-GPU.cmd, then refresh GPU status.');
  const id=state.image.id,settings=localGPUSettings();
  if(state.image.width*state.image.height*settings.scale**2>64000000)throw Error('Output exceeds 64 megapixels. Choose 2× or crop the original.');
  enhancementRunning=true;$('#enhancement-provider').disabled=true;$('#enhance-button').disabled=true;updateEnhancementControls();
  $('#enhance-button').textContent='Processing on your GPU…';$('#gpu-progress').value=0;$('#gpu-job-status').textContent='Starting local GPU enhancement…';
  try{
    const job=await jsonPost('/api/local-gpu/images/'+id,settings);rememberGPUJob(job.id);
    await watchLocalGPU(job.id);
  }finally{enhancementRunning=false;$('#enhancement-provider').disabled=false;updateEnhancementControls();}
}
function initLocalGPU(){
  for(const id of ['model','scale','strength','tile','precision'])$('#gpu-'+id).oninput=updateEnhancementControls;
  $('#gpu-refresh').onclick=()=>refreshLocalGPU().catch(failure);
  $('#gpu-cancel').onclick=async()=>{
    if(!localGPU.job)return;$('#gpu-cancel').disabled=true;
    try{const job=await jsonPost('/api/local-gpu/jobs/'+localGPU.job+'/cancel',{});$('#gpu-job-status').textContent=job.message;}
    catch(error){$('#gpu-cancel').disabled=false;failure(error);}
  };
  refreshLocalGPU().catch(error=>{$('#gpu-device').textContent=error.message;});
}
