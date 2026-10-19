"""Live local-server checks of cutout removal, spatial search, and saved views."""
import hashlib
import json
from pathlib import Path
import httpx
from integrations import now

report={'checked_at':now(),'blocked_cutouts':[]}
with httpx.Client(base_url='http://127.0.0.1:8765',timeout=180) as c:
    for quality in [512,1024]:
        response=c.post('/api/atlas/prepare',json={'record_id':'1167721488','ra':159.216,'dec':-58.621,'fov':.02,'quality':quality})
        assert response.status_code==410,response.text
        report['blocked_cutouts'].append({'quality':quality,'status':response.status_code})
    status=c.get('/api/atlas/status').json();report['coverage']=status['coverage']
    assert status['coverage']['ready']
    nearby=c.get('/api/navigation/nearby',params={'ra':159.216,'dec':-58.621,'radius':.2,'limit':6}).json()
    assert nearby['coverage_index_ready'] and nearby['sample_limited'] is False
    assert any(r['contains_view_center'] for r in nearby['rows']);report['nearby']=nearby
    report['packs']=[]
    for pack in status['packs']:
        results=[]
        for v in pack['views']:
            if v.get('view'):
                image=c.get(v['view']['url']);image.raise_for_status()
                results.append({'index':v['index'],'bytes':len(image.content),'sha256':hashlib.sha256(image.content).hexdigest()})
        report['packs'].append({'id':pack['id'],'title':pack['title'],'revision':pack['revision'],'state':pack['state'],'views_verified':results})
    # Prove cached-only responses without contacting external survey servers.
    previous=status['cached_only']
    try:
        c.post('/api/atlas/cached-only',params={'enabled':True}).raise_for_status()
        r=c.get('/api/atlas/surveys/optical/properties');assert r.status_code==200
        missing=c.get('/api/atlas/surveys/optical/Norder29/Dir0/Npix0.jpg');assert missing.status_code==503
        report['cached_only']={'cached_survey_http':r.status_code,'uncached_tile_http':missing.status_code,'uncached_detail':missing.json()['detail']}
    finally:c.post('/api/atlas/cached-only',params={'enabled':previous}).raise_for_status()
path=Path(__file__).parent/'data'/'verification'/'atlas-api.json';path.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({'verified':True,'blocked_cutouts':len(report['blocked_cutouts']),'observations':report['coverage']['indexed'],'packs':len(report['packs']),'receipt':str(path)}))
