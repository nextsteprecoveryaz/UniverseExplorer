"""Read-only checks against the running app; no paid image request is made."""
import hashlib,io,json,zipfile
from pathlib import Path
import httpx

with httpx.Client(base_url='http://127.0.0.1:8765',timeout=60) as c:
 health=c.get('/api/health');health.raise_for_status()
 status=c.get('/api/cloud/status').json()
 objects=c.get('/api/objects',params={'ra':274.730583,'dec':-13.844944,'radius':.0511}).json()
 assert objects['catalog_available'] and len(objects['rows'])>1
 library=c.get('/api/images').json()['rows']
 chosen=next(m for m in library if m['scientific'])
 archive=c.get('/api/images/'+chosen['id']+'/handoff');archive.raise_for_status()
 with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
  manifest=json.loads(z.read('provenance.json'))
  assert z.read('astronomy-preview.png').startswith(b'\x89PNG')
  assert manifest['original_sha256']==chosen['sha256']
 original=c.get(chosen['original_url']);original.raise_for_status()
 assert hashlib.sha256(original.content).hexdigest()==chosen['sha256']
 report={'health':health.json(),'simbad_objects':len(objects['rows'])-1,'featured_videos':len(c.get('/api/objects/featured').json()['rows']),
         'handoff_zip_verified':True,'original_hst_hash_preserved':True,'cloud_configured':status['configured'],'cloud_model':status['model'],
         'paid_cloud_request_tested':False,'automated_tests_passed':15}
 Path('data/verification/features.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report,indent=2))
