"""Opt-in OpenAI image editing. Credentials never leave the local backend except to OpenAI."""
import base64
import ctypes
from ctypes import wintypes
import hashlib
import io
import json
import os
import uuid
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, PngImagePlugin
import integrations
import science

MODEL='gpt-image-2.5-sunburst'
KEY_FILE=Path(__file__).parent/'data'/'openai-key.dpapi'
SESSION_KEY=None
BASE_PROMPT=('Enhance the supplied astronomical image for visual presentation. Preserve the original composition, field of view, colors, locations and number of visible sources, and existing credit marks. Gently reduce noise and improve clarity and local contrast. Do not add stars, planets, gas structures, labels, or invented objects. Do not imply recovered measurements or discoveries. This is a visualization, not scientific reconstruction.')

class CloudError(Exception):
 def __init__(self,message,status=400):
  super().__init__(message);self.status=status

class Blob(ctypes.Structure):
 _fields_=[('cbData',wintypes.DWORD),('pbData',ctypes.POINTER(ctypes.c_ubyte))]

def protect(data,decrypt=False):
 if os.name!='nt':raise CloudError('Remembering keys requires Windows. Use a session-only key.')
 buffer=ctypes.create_string_buffer(data)
 source=Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)));target=Blob()
 crypt=ctypes.WinDLL('crypt32',use_last_error=True)
 if decrypt:
  crypt.CryptUnprotectData.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
  ok=crypt.CryptUnprotectData(ctypes.byref(source),None,None,None,None,1,ctypes.byref(target))
 else:
  crypt.CryptProtectData.argtypes=[ctypes.POINTER(Blob),wintypes.LPCWSTR,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
  ok=crypt.CryptProtectData(ctypes.byref(source),'Universe Explorer OpenAI key',None,None,None,1,ctypes.byref(target))
 if not ok:raise CloudError('Windows could not unlock or save the API key. Reconnect OpenAI in this app.')
 try:return ctypes.string_at(target.pbData,target.cbData)
 finally:
  kernel=ctypes.WinDLL('kernel32',use_last_error=True)
  kernel.LocalFree.argtypes=[ctypes.c_void_p];kernel.LocalFree.restype=ctypes.c_void_p
  kernel.LocalFree(target.pbData)

def get_key():
 if SESSION_KEY:return SESSION_KEY
 if KEY_FILE.exists():return protect(KEY_FILE.read_bytes(),decrypt=True).decode()
 return os.environ.get('OPENAI_API_KEY','').strip()

def status():
 try:
  configured=bool(get_key());problem=None
 except (CloudError,OSError,UnicodeError):
  configured=False;problem='Saved key could not be read. Reconnect OpenAI.'
 return {'configured':configured,'model':MODEL,'storage':'Windows encrypted storage' if KEY_FILE.exists() else 'session' if SESSION_KEY else 'environment' if configured else None,'problem':problem}

def response_error(response):
 if response.status_code==401:return CloudError('OpenAI rejected the API key. Check the key in Cloud connection.',401)
 if response.status_code in (403,404):return CloudError('This OpenAI account does not have access to the image model. Check project permissions and model access.',403)
 if response.status_code==429:return CloudError('OpenAI reported a quota or rate limit. Check API billing and limits before retrying.',429)
 return CloudError('OpenAI could not complete this image edit. No local original was changed. Check the request in your API dashboard before retrying.',502)

async def connect(key,remember=False):
 global SESSION_KEY
 key=key.strip()
 if not 20<=len(key)<=1000 or any(c.isspace() for c in key):raise CloudError('Enter a valid OpenAI API key in this form.')
 async with httpx.AsyncClient(timeout=25) as client:
  response=await client.get('https://api.openai.com/v1/models/'+MODEL,headers={'Authorization':'Bearer '+key})
 if not response.is_success:raise response_error(response)
 if remember:
  encrypted=protect(key.encode());KEY_FILE.write_bytes(encrypted)
 elif KEY_FILE.exists():KEY_FILE.unlink()
 SESSION_KEY=key
 return status()

def disconnect():
 global SESSION_KEY
 SESSION_KEY=None
 if KEY_FILE.exists():KEY_FILE.unlink()
 return status()

def prepare(image_id,stretch='asinh'):
 m=science.metadata(image_id)
 with Image.open(science.render(image_id,stretch)) as image:
  im=image.convert('RGB');im.thumbnail((1600,1600));out=io.BytesIO();im.save(out,format='PNG')
 return m,out.getvalue(),list(im.size)

def save_result(image_id,content,*,provider,model,prompt,input_size,input_sha256,request_id=None):
 m=science.metadata(image_id)
 try:
  with Image.open(io.BytesIO(content)) as image:
   if image.width*image.height>25_000_000:raise ValueError('Cloud result exceeds 25 million pixels.')
   im=image.convert('RGB')
 except (OSError,Image.DecompressionBombError) as exc:
  raise CloudError('The enhancement result is not a supported image.') from exc
 variant=uuid.uuid4().hex
 # Fit a permanent label even on small returned images.
 draw=ImageDraw.Draw(im);label='AI VISUALIZATION - NOT SCIENTIFIC DATA'
 draw.rectangle((0,max(0,im.height-22),im.width,im.height),fill='black')
 draw.text((5,max(0,im.height-18)),label,fill='white')
 provenance={'provider':provider,'model':model,'prompt':prompt,'original_sha256':m['sha256'],'input_preview_sha256':input_sha256,'scientific_evidence':False,'created_at':integrations.now(),'request_id':request_id}
 png=PngImagePlugin.PngInfo();png.add_text('Provenance',json.dumps(provenance))
 im.save(science.IMAGES/(image_id+'-cloud-'+variant+'.png'),pnginfo=png)
 result={**provenance,'variant':variant,'input_size':input_size,'output_size':list(im.size),'url':f'/api/images/{image_id}/cloud-ai/{variant}',
  'note':f'{provider} visualization. May invent or distort features. Original data preserved; never used by the source detector.'}
 m.setdefault('cloud_history',[]).append(result);m['cloud_ai']=result;science.save_metadata(m)
 return m

async def enhance(image_id,quality='medium',instructions='',stretch='asinh'):
 key=get_key()
 if not key:raise CloudError('Connect an OpenAI API key first, or use the ChatGPT handoff option.',409)
 m,content,input_size=prepare(image_id,stretch)
 prompt=BASE_PROMPT+('\nAdditional visual preferences: '+instructions if instructions.strip() else '')
 try:
  # One request, no automatic retries: a retry could charge for a second image.
  async with httpx.AsyncClient(timeout=httpx.Timeout(330,connect=20)) as client:
   response=await client.post('https://api.openai.com/v1/images/edits',headers={'Authorization':'Bearer '+key},
     data={'model':MODEL,'prompt':prompt,'quality':quality,'size':'auto','n':'1','output_format':'png'},files={'image[]':('astronomy-preview.png',content,'image/png')})
 except httpx.HTTPError as exc:
  raise CloudError('The OpenAI connection ended before a result arrived. Check your API dashboard before retrying; a request may have been processed.',504) from exc
 if not response.is_success:raise response_error(response)
 try:output=base64.b64decode(response.json()['data'][0]['b64_json'],validate=True)
 except (ValueError,KeyError,IndexError,TypeError) as exc:raise CloudError('OpenAI returned no usable image. Check the API dashboard before retrying.',502) from exc
 return save_result(image_id,output,provider='OpenAI cloud',model=MODEL,prompt=prompt,input_size=input_size,input_sha256=hashlib.sha256(content).hexdigest(),request_id=response.headers.get('x-request-id'))
