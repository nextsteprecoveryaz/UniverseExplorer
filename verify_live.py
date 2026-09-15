"""Integration smoke checks against the running local app; stores evidence."""
import concurrent.futures
import json
import time
from pathlib import Path
import httpx

ROOT=Path(__file__).parent
def check(path):
    started=time.time()
    try:
        with httpx.Client(timeout=100) as c:
            r=c.get('http://127.0.0.1:8765'+path);r.raise_for_status();data=r.json()
        dest=ROOT/'data'/'verification';dest.mkdir(parents=True,exist_ok=True)
        name=path.split('?')[0].rsplit('/',1)[-1]
        (dest/(name+'.json')).write_text(json.dumps(data,ensure_ascii=True,indent=2),encoding='utf-8')
        result={'path':path,'seconds':round(time.time()-started,2),'status':r.status_code,'rows':len(data.get('rows',[])),'keys':list(data)}
        if name=='resolve':result.update(data)
        if name=='archive':result['paging']=data.get('paging')
        if name=='live':result['feeds']=[{k:o.get(k) for k in ['telescope','target','error','stale']} for o in data.get('rows',[])]
        print(json.dumps(result),flush=True)
    except Exception as e:print(json.dumps({'path':path,'error':str(e),'seconds':round(time.time()-started,2)}),flush=True)

if __name__=='__main__':
    paths=['/api/live','/api/resolve?name=M31','/api/archive?ra=83.82208&dec=-5.39111&radius=0.02&telescope=hubble','/api/exoplanets?ra=346.622&dec=-5.041&radius=0.1','/api/catalog-match?ra=83.82208&dec=-5.39111']
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as p:list(p.map(check,paths))
