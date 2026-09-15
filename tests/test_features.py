import asyncio
import base64
import hashlib
import io
import json
import os
import zipfile
import httpx
import pytest
from PIL import Image
from fastapi.testclient import TestClient
import cloud_ai
import integrations
import object_map
import science
from app import app

@pytest.fixture(autouse=True)
def isolated(tmp_path,monkeypatch):
 monkeypatch.setattr(science,'IMAGES',tmp_path)
 monkeypatch.setattr(cloud_ai,'KEY_FILE',tmp_path/'key.dpapi')
 monkeypatch.setattr(cloud_ai,'SESSION_KEY',None)
 monkeypatch.delenv('OPENAI_API_KEY',raising=False)

def raster():
 out=io.BytesIO();Image.new('RGB',(100,80),'navy').save(out,format='PNG');return out.getvalue()

def test_cloud_requires_connection_and_does_not_expose_secrets():
 c=TestClient(app)
 assert c.get('/api/cloud/status').json()['configured'] is False
 m=science.import_image(raster(),'original.png')
 r=c.post('/api/images/'+m['id']+'/enhance-cloud',json={})
 assert r.status_code==409
 assert science.metadata(m['id']).get('cloud_ai') is None
 assert c.post('/api/cloud/connect',headers={'Origin':'https://other.example'},json={'api_key':'x'*25}).status_code==403

def test_cloud_edit_sends_preview_once_and_preserves_local_original(monkeypatch):
 original=raster();m=science.import_image(original,'original.png')
 m['ai']={'note':'Existing local output'};science.save_metadata(m)
 monkeypatch.setattr(cloud_ai,'SESSION_KEY','test-key-never-log')
 calls=[]
 class Client:
  def __init__(self,**kwargs):pass
  async def __aenter__(self):return self
  async def __aexit__(self,*args):pass
  async def post(self,url,**kwargs):
   calls.append((url,kwargs))
   return httpx.Response(200,json={'data':[{'b64_json':base64.b64encode(raster()).decode()}]},headers={'x-request-id':'test-request'})
 monkeypatch.setattr(cloud_ai.httpx,'AsyncClient',Client)
 result=asyncio.run(cloud_ai.enhance(m['id'],'medium','Keep colors'))
 assert len(calls)==1 and calls[0][0]=='https://api.openai.com/v1/images/edits'
 assert calls[0][1]['data']['model']==cloud_ai.MODEL
 assert calls[0][1]['files']['image[]'][1].startswith(b'\x89PNG')
 assert result['ai']==m['ai']
 assert (science.IMAGES/(m['id']+'.png')).read_bytes()==original
 assert result['sha256']==hashlib.sha256(original).hexdigest()
 assert 'test-key-never-log' not in json.dumps(result)
 assert result['cloud_ai']['scientific_evidence'] is False
 path=science.IMAGES/(m['id']+'-cloud-'+result['cloud_ai']['variant']+'.png')
 assert json.loads(Image.open(path).info['Provenance'])['scientific_evidence'] is False

def test_external_enhancement_and_handoff_preserve_provenance():
 c=TestClient(app);m=science.import_image(raster(),'original.png')
 handoff=c.get('/api/images/'+m['id']+'/handoff')
 with zipfile.ZipFile(io.BytesIO(handoff.content)) as archive:
  manifest=json.loads(archive.read('provenance.json'))
  assert manifest['original_sha256']==m['sha256']
  assert set(archive.namelist())=={'astronomy-preview.png','prompt.txt','provenance.json'}
 r=c.post('/api/images/'+m['id']+'/import-enhancement',files={'file':('returned.png',raster(),'image/png')})
 assert r.status_code==200
 result=r.json()['cloud_ai']
 assert result['provider']=='Imported AI result'
 assert 'not verified' in result['model']
 assert c.get(result['url']).status_code==200
 assert c.get('/api/images/'+m['id']+'/cloud-ai/not-a-variant').status_code==404

def test_png_original_bytes_survive_preview_conversion():
 from PIL import PngImagePlugin
 out=io.BytesIO();info=PngImagePlugin.PngInfo();info.add_text('Original metadata','Must survive')
 Image.new('RGBA',(1800,10),(90,70,60,100)).save(out,format='PNG',pnginfo=info)
 content=out.getvalue();m=science.import_image(content,'original-with-alpha.png')
 assert TestClient(app).get(m['original_url']).content==content
 assert m['preview_width']==1600

def test_simbad_results_and_failure_are_distinct(monkeypatch):
 async def catalog(*args,**kwargs):
  return {'data':{'metadata':[{'name':x} for x in ['main_id','ra','dec','otype']],'data':[['A known source',274.73,-13.84,'Y*O']]},'fetched_at':'2026-09-14T00:00:00+00:00','stale':False}
 monkeypatch.setattr(integrations,'remote_json',catalog)
 result=asyncio.run(object_map.objects(274.730583,-13.844944,.1))
 assert result['catalog_available']
 assert any(o['id']=='pillars' and o['video_url'] for o in result['rows'])
 source=next(o for o in result['rows'] if not o['featured'])
 assert source['type']=='Young stellar object' and 'video_url' not in source
 async def unavailable(*args,**kwargs):raise ValueError('Unavailable')
 monkeypatch.setattr(integrations,'remote_json',unavailable)
 result=asyncio.run(object_map.objects(274.730583,-13.844944,.1))
 assert not result['catalog_available'] and result['rows'][0]['id']=='pillars'

def test_angular_matching_wraps_ra_and_handles_poles():
 assert object_map.separation(359.99,0,.01,0)==pytest.approx(.02)
 assert object_map.separation(0,90,180,90)<1e-8

@pytest.mark.skipif(os.name!='nt',reason='Windows DPAPI')
def test_windows_key_encryption_roundtrip():
 plain=b'test-key-encryption-only-not-a-real-key'
 encrypted=cloud_ai.protect(plain)
 assert plain not in encrypted
 assert cloud_ai.protect(encrypted,decrypt=True)==plain
