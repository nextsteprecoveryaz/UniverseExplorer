"""ElevenLabs narration, with durable local audio and Windows-protected credentials."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr

import cloud_ai
import integrations as remote
from narration import mp3_signature

DATA=Path(__file__).parent/'data'
ROOT=DATA/'narration-elevenlabs'
KEY_FILE=DATA/'elevenlabs-key.dpapi'
SETTINGS_FILE=DATA/'elevenlabs-voice.json'
DEFAULT_VOICE='BNgbHR0DNeZixGQVzloa'
MODEL='eleven_multilingual_v2'
FORMAT='mp3_44100_128'
VOICE_SETTINGS={'stability':.5,'similarity_boost':.75,'style':0,'use_speaker_boost':True,'speed':1.0}
MAX_AUDIO_BYTES=16*1024*1024
TIMEOUT=120
BASE='https://api.elevenlabs.io/v1'
router=APIRouter(prefix='/api/narration/elevenlabs',tags=['Narration'])
_inflight={}


class ClipRequest(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True,str_strip_whitespace=True)
    text:str=Field(min_length=1,max_length=3500)


class Connection(BaseModel):
    model_config=ConfigDict(extra='forbid')
    api_key:SecretStr
    voice_id:str=Field(default=DEFAULT_VOICE,pattern=r'^[A-Za-z0-9]{10,64}$')


def get_key():
    try:
        return cloud_ai.protect(KEY_FILE.read_bytes(),decrypt=True).decode() if KEY_FILE.exists() else os.environ.get('ELEVENLABS_API_KEY','').strip()
    except (cloud_ai.CloudError,OSError,UnicodeError):
        raise HTTPException(409,'The saved ElevenLabs key could not be unlocked. Reconnect ElevenLabs.') from None


def settings():
    try:
        value=json.loads(SETTINGS_FILE.read_text(encoding='utf-8'))
        if isinstance(value,dict) and re.fullmatch(r'[A-Za-z0-9]{10,64}',value.get('voice_id','')):return value
    except (OSError,ValueError,TypeError):pass
    return {'voice_id':DEFAULT_VOICE,'voice_name':None}


def atomic_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix('.'+uuid.uuid4().hex+'.tmp')
    try:
        temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(path)
    finally:temp.unlink(missing_ok=True)


def make_client():
    # Never retry a chargeable request automatically or forward credentials to redirects.
    return httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT,connect=15),follow_redirects=False)


def api_error(code):
    if code==401:return HTTPException(401,'ElevenLabs rejected the API key. Reconnect ElevenLabs.')
    if code in (403,404):return HTTPException(403,'ElevenLabs could not access this voice. Check voice access and API-key permissions.')
    if code==429:return HTTPException(429,'ElevenLabs reported a quota or rate limit. Check your credits and limits before retrying.')
    return HTTPException(502,'ElevenLabs could not generate narration. Check your API history before retrying.')


@router.get('/status')
def status():
    problem=None
    try:configured=bool(get_key())
    except HTTPException as error:configured=False;problem=error.detail
    files=list(ROOT.glob('*.mp3')) if ROOT.exists() else []
    return {**settings(),'configured':configured,'storage':'Windows encrypted storage' if KEY_FILE.exists() else 'environment' if configured else None,
            'model':MODEL,'output_format':FORMAT,'cached_clips':len(files),'cached_bytes':sum(p.stat().st_size for p in files),
            'problem':problem,'disclosure':'AI-generated ElevenLabs voice. New scripts use API credits; saved audio plays locally.'}


@router.post('/connect')
async def connect(body:Connection):
    key=body.api_key.get_secret_value().strip()
    if not 20<=len(key)<=1000 or any(c.isspace() for c in key):raise HTTPException(400,'Enter a valid ElevenLabs API key.')
    try:
        async with make_client() as client:r=await client.get(BASE+'/voices/'+body.voice_id,headers={'xi-api-key':key})
    except httpx.HTTPError:raise HTTPException(502,'ElevenLabs voice verification could not connect. Try again.') from None
    if not r.is_success:raise api_error(r.status_code)
    try:
        voice=r.json()
        if voice['voice_id']!=body.voice_id:raise ValueError()
    except (ValueError,KeyError,TypeError):raise HTTPException(502,'ElevenLabs returned no matching voice.') from None
    try:
        encrypted=cloud_ai.protect(key.encode());KEY_FILE.parent.mkdir(parents=True,exist_ok=True)
        temp=KEY_FILE.with_suffix('.'+uuid.uuid4().hex+'.tmp')
        try:temp.write_bytes(encrypted);temp.replace(KEY_FILE)
        finally:temp.unlink(missing_ok=True)
        atomic_json(SETTINGS_FILE,{'voice_id':body.voice_id,'voice_name':str(voice.get('name') or '')[:200]})
    except (cloud_ai.CloudError,OSError):raise HTTPException(500,'Windows could not save the ElevenLabs connection securely.') from None
    return status()


@router.delete('/connection')
def disconnect():
    KEY_FILE.unlink(missing_ok=True)
    return status()


def identity(request,voice):
    # Route IDs, revisions, whitespace layout and stop order do not affect speech.
    text=' '.join(request.text.split())
    if not text:raise HTTPException(422,'Enter narration text.')
    try:text.encode('utf-8')
    except UnicodeError:raise HTTPException(422,'Narration must contain valid Unicode.') from None
    return {'provider':'ElevenLabs','voice_id':voice,'model_id':MODEL,'output_format':FORMAT,'voice_settings':VOICE_SETTINGS,'text':text}


def cache_key(spec):
    return hashlib.sha256(json.dumps(spec,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def paths(key):
    if not re.fullmatch(r'[a-f0-9]{64}',key):raise HTTPException(404,'Saved narration not found.')
    root=ROOT.resolve();audio=root/(key+'.mp3');meta=root/(key+'.json');attempt=root/(key+'.attempt.json')
    if any(p.resolve().parent!=root for p in (audio,meta,attempt)):raise HTTPException(404,'Saved narration not found.')
    return audio,meta,attempt


def result(spec,key,cached):
    return {'url':f'/api/narration/elevenlabs/audio/{key}.mp3','cache_key':key,'cached':cached,'voice_id':spec['voice_id'],'model':spec['model_id'],
            'disclosure':'AI-generated ElevenLabs narration; saved permanently on this PC.'}


def cached_clip(spec,key):
    audio,meta,attempt=paths(key)
    if not audio.exists():return None
    try:
        content=audio.read_bytes()
        saved=json.loads((meta if meta.exists() else attempt).read_text(encoding='utf-8'))
        if not isinstance(saved,dict) or saved.get('identity')!=spec or not 0<len(content)<=MAX_AUDIO_BYTES or not mp3_signature(content):raise ValueError()
        digest=hashlib.sha256(content).hexdigest()
        if meta.exists() and (saved.get('sha256')!=digest or saved.get('bytes')!=len(content)):raise ValueError()
        if not meta.exists():
            # Recover a completed MP3 after a metadata-write failure without a new API call.
            atomic_json(meta,{'identity':spec,'created_at':saved.get('created_at'),'bytes':len(content),'sha256':digest,'recovered':True})
        attempt.unlink(missing_ok=True)
        return result(spec,key,True)
    except (OSError,ValueError,TypeError):
        raise HTTPException(409,'Saved ElevenLabs audio needs repair. Restore its backup; the app will not generate and charge for it again automatically.') from None


async def generate(spec,key):
    existing=cached_clip(spec,key)
    if existing:return existing
    audio,meta,attempt=paths(key)
    if attempt.exists():raise HTTPException(409,'An earlier ElevenLabs request was interrupted. Check ElevenLabs history before generating it again; automatic repeat billing is blocked.')
    api_key=get_key()
    if not api_key:raise HTTPException(409,'Connect ElevenLabs to generate this script. Previously saved audio remains playable.')
    # Persist before sending, so a restart or disk failure cannot silently rebill.
    try:atomic_json(attempt,{'identity':spec,'created_at':remote.now(),'state':'requested'})
    except OSError:raise HTTPException(500,'Cannot save narration locally. Check disk space before generating.') from None
    content=bytearray();request_id=None
    try:
        async with asyncio.timeout(TIMEOUT):
            async with make_client() as client:
                async with client.stream('POST',BASE+'/text-to-speech/'+spec['voice_id'],params={'output_format':FORMAT},
                                         headers={'xi-api-key':api_key},json={k:spec[k] for k in ('text','model_id','voice_settings')}) as response:
                    if not response.is_success:
                        if response.status_code in (400,401,403,404,422,429):attempt.unlink(missing_ok=True)
                        raise api_error(response.status_code)
                    if response.headers.get('content-type','').split(';')[0].lower() not in ('audio/mpeg','audio/mp3','application/octet-stream'):
                        raise HTTPException(502,'ElevenLabs returned no usable MP3. Check API history before retrying.')
                    async for chunk in response.aiter_bytes(64*1024):
                        content.extend(chunk)
                        if len(content)>MAX_AUDIO_BYTES:raise HTTPException(502,'ElevenLabs audio exceeded the local size limit. Check API history before retrying.')
                    value=response.headers.get('request-id') or response.headers.get('x-request-id')
                    if value and re.fullmatch(r'[A-Za-z0-9_.-]{1,200}',value):request_id=value
    except (httpx.HTTPError,TimeoutError):raise HTTPException(504,'ElevenLabs generation was interrupted. Check API history; automatic repeat billing is blocked.') from None
    if not content or not mp3_signature(content):raise HTTPException(502,'ElevenLabs returned invalid audio. Check API history before retrying.')
    temporary=audio.with_suffix('.'+uuid.uuid4().hex+'.tmp')
    try:
        temporary.write_bytes(content);temporary.replace(audio)
        atomic_json(meta,{'identity':spec,'created_at':remote.now(),'request_id':request_id,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest(),
                          'ai_generated':True,'documentation_url':'https://elevenlabs.io/docs/api-reference/text-to-speech/convert'})
        attempt.unlink(missing_ok=True)
    except OSError:raise HTTPException(500,'Audio was generated but saving could not finish. Keep the cache files; automatic repeat billing is blocked.') from None
    finally:temporary.unlink(missing_ok=True)
    return result(spec,key,False)


@router.post('/clip')
async def clip(request:ClipRequest):
    return await clip_for_voice(request,settings()['voice_id'])


async def clip_for_voice(request,voice):
    spec=identity(request,voice);key=cache_key(spec)
    existing=cached_clip(spec,key)
    if existing:return existing
    task=_inflight.get(key)
    if task is None:
        task=asyncio.create_task(generate(spec,key));_inflight[key]=task
        def completed(done):
            if _inflight.get(key) is done:_inflight.pop(key,None)
            if not done.cancelled():done.exception()
        task.add_done_callback(completed)
    return await asyncio.shield(task)


@router.get('/audio/{key}.mp3')
def audio(key:str):
    path,_,_=paths(key)
    if not path.is_file() or not 0<path.stat().st_size<=MAX_AUDIO_BYTES:raise HTTPException(404,'Saved narration not found.')
    return FileResponse(path,media_type='audio/mpeg',headers={'Cache-Control':'private, max-age=31536000, immutable'})
