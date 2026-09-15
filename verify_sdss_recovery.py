"""Exercise live SDSS/CDS image delivery and cached reuse through the local app.

Run pytest tests/test_sdss.py for deterministic timeout/outage fault injection.
This script does not clear caches or manufacture upstream failures.
"""
import hashlib
import io
import json
import time
from pathlib import Path

import httpx
from PIL import Image


def main():
    record={'checked_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'images':[]}
    with httpx.Client(base_url='http://127.0.0.1:8765',timeout=15) as client:
        def load(body):
            start=time.monotonic();response=client.post('/api/sdss/cutout',json=body);response.raise_for_status()
            job=response.json();last=None;messages=[]
            while job['state'] in ('queued','running'):
                if time.monotonic()-start>240:raise TimeoutError('SDSS verification deadline reached')
                if job.get('message')!=last:
                    last=job.get('message');messages.append(last);print(last,flush=True)
                time.sleep(.25)
                response=client.get('/api/atlas/jobs/'+job['id']);response.raise_for_status();job=response.json()
            if job['state']!='complete':raise RuntimeError(job.get('error',job['state']))
            return job['result'],round(time.monotonic()-start,3),messages

        for body in [
            {'ra':229.52558,'dec':42.74585,'fov':.091,'size':2048,'source':'auto'},
            {'ra':202.4696,'dec':47.1953,'fov':.231,'size':2048,'source':'cds'},
        ]:
            result,seconds,messages=load(body)
            response=client.get(result['url']);response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as image:
                image.load();assert image.size==(2048,2048) and image.format=='JPEG'
            assert result['sha256']==hashlib.sha256(response.content).hexdigest()
            assert result['ra']==body['ra'] and result['dec']==body['dec'] and result['fov']==body['fov']
            if body['source']=='cds':
                assert result['provider']=='cds' and 'DR9' in result['source_label']
                assert 'CDS%2FP%2FSDSS9%2Fcolor' in result['source']['source_url']
            cached,cached_seconds,_=load({**body,'source':'auto'})
            assert cached['sha256']==result['sha256'] and 'local cache' in cached['delivery_note']
            item={k:result[k] for k in ('id','provider','source','size','sha256')}
            item.update(seconds=seconds,cached_seconds=cached_seconds,messages=messages)
            record['images'].append(item);print(json.dumps(item),flush=True)
        record['cache_limit_gib']=client.get('/api/atlas/status').json()['limit_bytes']/1024**3
    path=Path(__file__).resolve().parent/'data'/'verification'/'sdss-recovery-live.json'
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(record,indent=2),encoding='utf-8')
    print('Live image sources, 2048px JPEGs, provenance, and cache reuse verified.',flush=True)


if __name__=='__main__':main()
