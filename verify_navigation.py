"""Verify the running local navigation API using real indexed telescope sources."""
import io
import json
from datetime import datetime,timezone
from pathlib import Path

import httpx
from PIL import Image

BASE='http://127.0.0.1:8765'

def main():
    evidence={'verified_at':datetime.now(timezone.utc).isoformat(),'checks':[]}
    with httpx.Client(base_url=BASE,timeout=90) as c:
        def get(path):
            response=c.get(path);response.raise_for_status();return response.json()
        def post(path,payload):
            response=c.post(path,json=payload);response.raise_for_status();return response.json()
        assert get('/api/health')['app']=='Universe Explorer'
        templates=get('/api/navigation/templates')['rows']
        assert len(templates)>=7
        evidence['tours']=[{'id':r['id'],'title':r['title'],'stops':len(r['stops'])} for r in templates]
        for t in templates:
            assert len(t['stops'])==len(t['media'])
            for stop,media in zip(t['stops'],t['media']):
                assert media['available'] and stop['source']['id']==media['id']
                assert stop['ra']==media['ra'] and stop['dec']==media['dec']
                if media['kind']=='gallery':assert media['classification']=='Published image'
        nearby=get('/api/navigation/nearby?ra=159.216&dec=-58.621&radius=0.5')
        assert nearby['rows'][0]['title']=='NGC-3324' and nearby['rows'][0]['contains_view_center'] is True
        evidence['carina']={k:nearby[k] for k in ('indexed_pointings_in_radius','candidate_records_checked','supported_footprints_checked','index_updated_at')}
        evidence['carina']['suggestions']=[{k:r[k] for k in ('id','title','ra','dec','distance_deg','contains_view_center','observed_at')} for r in nearby['rows']]
        first_hubble=next(t for t in templates if t['id']=='recent-hst')['stops'][0]
        hubble=get(f"/api/navigation/nearby?ra={first_hubble['ra']}&dec={first_hubble['dec']}&radius=1&mission=hubble")
        assert hubble['rows'] and not hubble['releases'] and all(r['mission']=='HST' for r in hubble['rows'])
        evidence['hubble_suggestions']=[{'id':r['id'],'title':r['title'],'mission':r['mission']} for r in hubble['rows']]
        evidence['previews']=[]
        for media in [nearby['rows'][0],hubble['rows'][0]]:
            response=c.get(media['preview_url']);response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as image:
                assert max(image.size)<=1200 and min(image.size)>0
                evidence['previews'].append({'id':media['id'],'mission':media['mission'],'http_status':response.status_code,'display_dimensions':image.size,'bytes':len(response.content)})
        template=templates[0]
        body={k:template[k] for k in ('title','description','kind','stops','track')}
        body['title']='Navigation verification fixture'
        created=[]
        try:
            route=post('/api/navigation/routes',body);created.append(route['id'])
            bundle=get('/api/navigation/routes/'+route['id']+'/export')
            copied=post('/api/navigation/import',bundle);created.append(copied['id'])
            assert route['stops']==copied['stops'] and route['id']!=copied['id']
            changed=c.put('/api/navigation/routes/'+route['id'],json={**body,'title':'Updated verification fixture','revision':1});changed.raise_for_status()
            assert changed.json()['revision']==2
            assert c.put('/api/navigation/routes/'+route['id'],json={**body,'revision':1}).status_code==409
            progress={'revision':2,'elapsed':5.2,'origin':{k:route['stops'][0][k] for k in ('ra','dec','fov','roll','survey','projection')}}
            c.put('/api/navigation/routes/'+route['id']+'/progress',json=progress).raise_for_status()
            assert get('/api/navigation/routes/'+route['id'])['progress']==progress
            evidence['checks']+=['Source coordinates match each tour stop','Gallery tours exclude identified non-image media','Carina exact footprint containment','Hubble-only suggestion filtering','Real Hubble and Webb previews decode','Route export/import equality and independent IDs','Revision conflict returns 409','Playback origin and elapsed time persist']
        finally:
            # Delete only the disposable fixtures created by this verification.
            for ident in created:
                current=get('/api/navigation/routes/'+ident)
                c.delete('/api/navigation/routes/'+ident,params={'revision':current['revision']}).raise_for_status()
        recorded=[r for r in get('/api/navigation/routes')['rows'] if r['kind']=='recording']
        evidence['existing_recordings']=[]
        for record in recorded:
            r=get('/api/navigation/routes/'+record['id'])
            assert all(b['t']>a['t'] for a,b in zip(r['track'],r['track'][1:]))
            evidence['existing_recordings'].append({'id':r['id'],'title':r['title'],'samples':len(r['track']),'first':r['track'][0],'last':r['track'][-1]})
    output=Path(__file__).parent/'data'/'verification'/'navigation-api.json'
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps(evidence,indent=2))

if __name__=='__main__':main()
