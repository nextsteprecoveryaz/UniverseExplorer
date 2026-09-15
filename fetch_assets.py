import concurrent.futures
import json
from pathlib import Path
import httpx

ROOT=Path(__file__).parent
def assets():
    dest=ROOT/'static'/'assets'
    dest.mkdir(parents=True,exist_ok=True)
    params={'hips':'CDS/P/JWST/EPO','width':1600,'height':1000,'fov':0.073,'projection':'TAN','coordsys':'icrs','ra':274.730583,'dec':-13.844944,'format':'jpg'}
    with httpx.Client(timeout=120,follow_redirects=True) as c:
        r=c.get('https://alasky.cds.unistra.fr/hips-image-services/hips2fits',params=params)
        r.raise_for_status()
        if not r.headers.get('content-type','').startswith('image/'):
            raise RuntimeError(r.text[:200])
        (dest/'pillars.jpg').write_bytes(r.content)
        (dest/'provenance.json').write_text(json.dumps({'image':'pillars.jpg','source_url':str(r.url),'credit':'NASA, ESA, CSA, STScI; CDS HiPS projection','kind':'Released JWST outreach composite'},indent=2))
        print('PILLARS_PREVIEW',len(r.content),flush=True)

def surveys():
    with httpx.Client(timeout=50,follow_redirects=True) as c:
        r=c.get('https://alasky.cds.unistra.fr/MocServer/query',params={'expr':'ID=CDS/P/HST/*','get':'record','fmt':'json'})
        r.raise_for_status()
    data=json.loads(r.text)
    (ROOT/'data'/'research'/'hst-surveys.json').write_text(json.dumps(data,ensure_ascii=True),encoding='utf-8')
    print('HST_SURVEYS',json.dumps([{k:x.get(k) for k in ['ID','obs_title','hips_service_url']} for x in data]),flush=True)

if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for f in [pool.submit(assets),pool.submit(surveys)]:
            try:f.result()
            except Exception as e:print(type(e).__name__,str(e),flush=True)
