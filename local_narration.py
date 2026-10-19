"""Windows speech rendered to cached WAV files; no cloud or browser voice required."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import uuid
import wave
from fastapi import APIRouter,HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel,ConfigDict,Field
from integrations import now

ROOT=Path(__file__).parent/'data'/'narration-local'
SCRIPT=Path(__file__).parent/'scripts'/'narrate_windows.ps1'
POWERSHELL=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32'/'WindowsPowerShell'/'v1.0'/'powershell.exe'
LOCK=threading.Lock()
MAX_BYTES=20*1024*1024
router=APIRouter(prefix='/api/narration/local')

class Request(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True,str_strip_whitespace=True)
    text:str=Field(min_length=1,max_length=3500)

def paths(key):
    if not re.fullmatch(r'[a-f0-9]{64}',key):raise HTTPException(404,'Narration not found.')
    return ROOT/(key+'.wav'),ROOT/(key+'.json')

def synthesize(request_path):
    if os.name!='nt' or not POWERSHELL.is_file():raise HTTPException(503,'Windows local narration is unavailable. Choose another narrator.')
    try:
        result=subprocess.run([str(POWERSHELL),'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(SCRIPT),'-RequestPath',str(request_path)],
            capture_output=True,text=True,encoding='utf-8',timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
    except (OSError,subprocess.TimeoutExpired):raise HTTPException(503,'Windows speech could not finish. Check installed voices or choose another narrator.') from None
    if result.returncode:raise HTTPException(503,'Windows speech is unavailable. Install a Windows speech voice or choose another narrator.')
    return json.loads(result.stdout.strip())

@router.post('/clip')
def clip(request:Request):
    key=hashlib.sha256(('windows-speech-v1|22050|rate0|'+request.text).encode('utf-8')).hexdigest();audio,meta=paths(key)
    with LOCK:
        try:
            saved=json.loads(meta.read_text(encoding='utf-8'))
            if saved['text']==request.text and saved['bytes']==audio.stat().st_size and 44<audio.stat().st_size<=MAX_BYTES:
                return {'url':f'/api/narration/local/audio/{key}.wav','cached':True,'voice':saved['voice'],'disclosure':'Windows speech generated locally.'}
        except (OSError,ValueError,KeyError,TypeError):pass
        ROOT.mkdir(parents=True,exist_ok=True);token=uuid.uuid4().hex;temporary=ROOT/(token+'.wav');config=ROOT/(token+'.json');meta_temp=ROOT/(token+'.meta')
        try:
            config.write_text(json.dumps({'text':request.text,'output':str(temporary.resolve())}),encoding='utf-8')
            info=synthesize(config)
            if not temporary.is_file() or not 44<temporary.stat().st_size<=MAX_BYTES:raise HTTPException(502,'Windows returned no usable audio.')
            with wave.open(str(temporary),'rb') as wav:
                duration=wav.getnframes()/wav.getframerate()
                if not 0<duration<600:raise HTTPException(502,'Windows returned invalid audio.')
            saved={'text':request.text,'provider':'Windows System.Speech','voice':info['voice'],'created_at':now(),'seconds':duration,
                   'bytes':temporary.stat().st_size,'sha256':hashlib.sha256(temporary.read_bytes()).hexdigest()}
            meta_temp.write_text(json.dumps(saved,ensure_ascii=False),encoding='utf-8');temporary.replace(audio);meta_temp.replace(meta)
            return {'url':f'/api/narration/local/audio/{key}.wav','cached':False,'voice':info['voice'],'disclosure':'Windows speech generated locally.'}
        finally:
            for path in (temporary,config,meta_temp):path.unlink(missing_ok=True)

@router.get('/audio/{key}.wav')
def get_audio(key:str):
    audio,_=paths(key)
    if not audio.is_file() or not 44<audio.stat().st_size<=MAX_BYTES:raise HTTPException(404,'Narration audio not found.')
    return FileResponse(audio,media_type='audio/wav',headers={'Cache-Control':'private, max-age=31536000, immutable'})
