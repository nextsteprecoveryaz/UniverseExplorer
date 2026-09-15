"""Live local-server checks of source cutouts, spatial search, and saved views."""
import hashlib
import io
import json
import time
from pathlib import Path
import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from integrations import now

report={'checked_at':now(),'cutouts':[]}
with httpx.Client(base_url='http://127.0.0.1:8765',timeout=180) as c:
    for ident,fov in [('1167721488',.02),('1208797559',.007)]:
        o=c.get('/api/recent/observations/'+ident).json()
        r=c.post('/api/atlas/prepare',json={'record_id':ident,'ra':o['s_ra'],'dec':o['s_dec'],'fov':fov});r.raise_for_status();job=r.json()
        deadline=time.monotonic()+200
        while job['state'] in ('queued','running') and time.monotonic()<deadline:
            time.sleep(1);job=c.get('/api/atlas/jobs/'+job['id']).json()
        assert job['state']=='complete',job
        m=job['result'];raw=c.get(m['url']);raw.raise_for_status()
        assert hashlib.sha256(raw.content).hexdigest()==m['sha256']
        with fits.open(io.BytesIO(raw.content)) as h:
            assert h[0].data.shape==(512,512) and h[0].header['VISONLY']
            w=WCS(h[0].header);pos=w.pixel_to_world(255.5,255.5)
            assert abs(pos.icrs.dec.deg-o['s_dec'])<1e-7
            assert abs((pos.icrs.ra.deg-o['s_ra']+180)%360-180)<1e-7
            assert np.isfinite(h[0].data).any()
        report['cutouts'].append(m)
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
print(json.dumps({'verified':True,'cutouts':len(report['cutouts']),'observations':report['coverage']['indexed'],'packs':len(report['packs']),'receipt':str(path)}))
