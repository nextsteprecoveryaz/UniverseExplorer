"""Background local CUDA enhancement jobs. Originals and scientific arrays are read-only."""
import hashlib,json,os,subprocess,threading,time,uuid
from pathlib import Path
from typing import Literal
from fastapi import APIRouter,HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel,Field
from PIL import Image,ImageDraw,ImageOps,PngImagePlugin
import numpy as np
import science
from gpu_models import ROOT,PYTHON,MODELS,model_path,MAX_OUTPUT_PIXELS

router=APIRouter(prefix='/api/local-gpu')
JOBS=ROOT/'data'/'gpu-enhancement';JOBS.mkdir(parents=True,exist_ok=True)
LOCK=threading.RLock();ACTIVE=None;PROCESSES={};CANCEL=set()
TERMINAL={'completed','failed','cancelled'}
FLAGS=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0

class Options(BaseModel):
    model:Literal['realesrnet','realesrgan']='realesrnet'
    scale:Literal[2,4]=2
    strength:float=Field(default=.8,ge=0,le=1)
    tile:Literal[128,256,512]=512
    precision:Literal['fp16','fp32']='fp16'
    stretch:Literal['asinh','linear','log']='asinh'

def job_path(job_id):
    if len(job_id)!=32 or any(c not in '0123456789abcdef' for c in job_id):raise HTTPException(404,'Job not found.')
    return JOBS/(job_id+'.json')

def read_job(job_id):
    path=job_path(job_id)
    if not path.exists():raise HTTPException(404,'Job not found.')
    return json.loads(path.read_text())

def write_job(job):
    path=job_path(job['id']);temp=path.with_suffix('.tmp');temp.write_text(json.dumps(job,allow_nan=False),encoding='utf-8');temp.replace(path)

def update(job_id,**values):
    with LOCK:
        job=read_job(job_id);job.update(values);write_job(job);return job

def installation():
    installed=PYTHON.exists() and all(model_path(k).exists() for k in MODELS)
    record=ROOT/'data'/'gpu-runtime.json'
    try:info=json.loads(record.read_text()) if record.exists() else {}
    except (OSError,ValueError):info={}
    return {'ready':bool(installed and info.get('gpu')),'device':info,'models':[{'id':k,**v} for k,v in MODELS.items()],
            'max_output_pixels':MAX_OUTPUT_PIXELS,'active_job':ACTIVE,
            'setup':'Run Setup-GPU.cmd in the app folder to install the isolated NVIDIA runtime and models.'}

def prepare(image_id,stretch,destination,scale):
    m=science.metadata(image_id)
    original=m.get('original_file','')
    if not original or Path(original).name!=original or not (science.IMAGES/original).is_file():
        raise ValueError('This image has no saved full-resolution original. Import the original file again before GPU enhancement.')
    source=science.IMAGES/original
    if hashlib.sha256(source.read_bytes()).hexdigest()!=m['sha256']:raise ValueError('The original image checksum changed. Import it again before enhancement.')
    if m['scientific']:
        arr=np.load(science.IMAGES/(image_id+'.npy'),allow_pickle=False)
        image=Image.fromarray(np.flipud(science.stretch_array(arr,stretch))).convert('RGB')
        kind='Full-resolution FITS display stretch (8-bit RGB); not calibrated data'
    else:
        with Image.open(source) as raw:
            raw=ImageOps.exif_transpose(raw);image=raw.convert('RGBA' if 'A' in raw.getbands() else 'RGB')
        kind='Full-resolution original raster converted to display RGB'
    if image.width*image.height*scale*scale>MAX_OUTPUT_PIXELS:raise ValueError('Output exceeds 64 megapixels. Choose 2× or crop the source; the app will not silently shrink it.')
    image.save(destination)
    return {'original_sha256':m['sha256'],'input_sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'input_kind':kind,'input_size':list(image.size)}

def save_result(job,folder,info,stats):
    image_id=job['image_id'];variant=job['id'];settings=job['settings'];model=MODELS[settings['model']]
    provenance={**info,**stats,'model':model['name'],'model_sha256':model['sha256'],'provider':'Local NVIDIA CUDA',
        'scale':settings['scale'],'strength':settings['strength'],'precision':settings['precision'],'tile':settings['tile'],'stretch':settings['stretch'],
        'scientific_evidence':False,'created_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    # Validate bounded raw output without weakening the app's original-image decode limit.
    pixels=np.load(folder/'output.npy',allow_pickle=False,mmap_mode='r')
    w,h=(v*settings['scale'] for v in info['input_size'])
    if pixels.dtype!=np.uint8 or pixels.ndim!=3 or pixels.shape[:2]!=(h,w) or pixels.shape[2] not in (3,4) or w*h>MAX_OUTPUT_PIXELS:raise ValueError('GPU returned unexpected image dimensions.')
    image=Image.fromarray(pixels).copy();del pixels
    draw=ImageDraw.Draw(image);draw.rectangle((0,max(0,image.height-24),image.width,image.height),fill='black')
    draw.text((5,max(0,image.height-19)),'AI VISUALIZATION - NOT SCIENTIFIC DATA - '+model['name'],fill='white')
    png=PngImagePlugin.PngInfo();png.add_text('Provenance',json.dumps(provenance,allow_nan=False))
    path=science.IMAGES/(image_id+'-gpu-'+variant+'.png');temp=path.with_suffix('.tmp')
    image.save(temp,format='PNG',pnginfo=png)
    result={**provenance,'variant':variant,'url':f'/api/local-gpu/images/{image_id}/{variant}',
        'note':f"Local CUDA · {model['name']} · {stats['gpu']}. Full-resolution input; AI may change apparent stars and structures. Original data preserved."}
    with LOCK:
        if job['id'] in CANCEL:temp.unlink(missing_ok=True);raise InterruptedError('Enhancement cancelled.')
        temp.replace(path)
        m=science.metadata(image_id);m.setdefault('local_history',[]).append(result);science.save_metadata(m)
    return result

def run_job(job_id):
    global ACTIVE
    folder=JOBS/job_id;folder.mkdir(exist_ok=True);watchdog=None
    try:
        job=update(job_id,status='running',progress=1,message='Preparing full-resolution original')
        info=prepare(job['image_id'],job['settings']['stretch'],folder/'input.png',job['settings']['scale'])
        config={**job['settings'],'input':str(folder/'input.png'),'output':str(folder/'output.npy')}
        (folder/'request.json').write_text(json.dumps(config))
        with LOCK:
            if job_id in CANCEL:raise InterruptedError('Enhancement cancelled.')
            process=subprocess.Popen([str(PYTHON),'-u',str(ROOT/'scripts'/'gpu_upscale_worker.py'),str(folder/'request.json')],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',creationflags=FLAGS)
            PROCESSES[job_id]=process
        watchdog=threading.Timer(1800,process.terminate);watchdog.daemon=True;watchdog.start()
        stats=None;error='The GPU worker did not complete. Check the local job log.'
        with (folder/'worker.log').open('w',encoding='utf-8') as log:
            for line in process.stdout:
                log.write(line);log.flush()
                try:event=json.loads(line)
                except ValueError:continue
                if 'error' in event:error=event['error']
                if 'result' in event:stats=event['result']
                if 'progress' in event:update(job_id,progress=event['progress'],message=event['message'])
        code=process.wait()
        with LOCK:
            if job_id in CANCEL:raise InterruptedError('Enhancement cancelled.')
            if code or not stats:raise RuntimeError(error)
        update(job_id,progress=97,message='Labeling and saving a separate result')
        result=save_result(job,folder,info,stats)
        update(job_id,status='completed',progress=100,message='Saved. Original preserved.',result=result)
    except InterruptedError:update(job_id,status='cancelled',message='Cancelled. Original preserved.')
    except Exception as error:
        update(job_id,status='cancelled' if job_id in CANCEL else 'failed',message=str(error),error=str(error))
    finally:
        if watchdog:watchdog.cancel()
        with LOCK:
            process=PROCESSES.pop(job_id,None)
            if process and process.poll() is None:process.terminate();process.wait(timeout=15)
            CANCEL.discard(job_id)
            if ACTIVE==job_id:ACTIVE=None
        for name in ['input.png','output.npy']:(folder/name).unlink(missing_ok=True)

@router.get('/status')
def status():return installation()

@router.post('/images/{image_id}',status_code=202)
def start(image_id:str,options:Options):
    global ACTIVE
    m=science.metadata(image_id)
    if m['width']*m['height']*options.scale**2>MAX_OUTPUT_PIXELS:raise HTTPException(422,'Output exceeds 64 megapixels. Choose 2× or crop the original.')
    if not installation()['ready']:raise HTTPException(503,'Local GPU enhancement is not installed. Run Setup-GPU.cmd.')
    with LOCK:
        if ACTIVE:raise HTTPException(409,'A local GPU enhancement is already running. Wait or cancel it first.')
        job={'id':uuid.uuid4().hex,'image_id':image_id,'settings':options.model_dump(),'status':'queued','progress':0,'message':'Queued locally','created_at':time.time()}
        write_job(job);ACTIVE=job['id'];threading.Thread(target=run_job,args=(job['id'],),daemon=True).start();return job

@router.get('/jobs/{job_id}')
def get_job(job_id:str):
    with LOCK:
        job=read_job(job_id)
        if job['status'] not in TERMINAL and job_id!=ACTIVE:job=update(job_id,status='failed',message='The app restarted before this job finished. Start it again.')
        return job

@router.post('/jobs/{job_id}/cancel')
def cancel(job_id:str):
    with LOCK:
        job=read_job(job_id)
        if job['status'] in TERMINAL:return job
        CANCEL.add(job_id);process=PROCESSES.get(job_id)
        if process and process.poll() is None:process.terminate()
        return update(job_id,status='cancelling',message='Stopping GPU worker…')

@router.get('/images/{image_id}/{variant}')
def image_result(image_id:str,variant:str,download:bool=False):
    m=science.metadata(image_id)
    if not any(r['variant']==variant for r in m.get('local_history',[])):raise HTTPException(404,'Local GPU result not found.')
    return FileResponse(science.IMAGES/(image_id+'-gpu-'+variant+'.png'),media_type='image/png',filename=f'{Path(m["name"]).stem}-AI-{variant[:8]}.png' if download else None)

def shutdown():
    with LOCK:
        if ACTIVE:cancel(ACTIVE)
