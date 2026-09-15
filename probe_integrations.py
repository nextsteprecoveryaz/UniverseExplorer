import concurrent.futures
import hashlib
import json
from pathlib import Path
import httpx

ROOT = Path(__file__).parent
DEST = ROOT / 'data' / 'research'
DEST.mkdir(parents=True, exist_ok=True)

def probe(name, url, **kwargs):
    try:
        with httpx.Client(timeout=55, follow_redirects=True) as c:
            r = c.get(url, **kwargs)
            r.raise_for_status()
        (DEST / (name + '.json')).write_text(r.text, encoding='utf-8')
        data = r.json()
        if name == 'surveys':
            data = [{k: x.get(k) for k in ['ID','obs_title','hips_service_url','hips_frame']} for x in data]
        elif name == 'mast':
            data = {'status':data.get('status'), 'paging':data.get('paging'), 'data':data.get('data',[])[:2]}
        print(name, json.dumps(data)[:14000], flush=True)
    except Exception as e:
        print(name, type(e).__name__, str(e), flush=True)

def model():
    url='https://raw.githubusercontent.com/Saafke/FSRCNN_Tensorflow/master/models/FSRCNN_x2.pb'
    with httpx.Client(timeout=60, follow_redirects=True) as c:
        r=c.get(url)
        r.raise_for_status()
        license=c.get('https://raw.githubusercontent.com/Saafke/FSRCNN_Tensorflow/master/LICENSE')
        license.raise_for_status()
    dest=ROOT/'models'
    dest.mkdir(exist_ok=True)
    (dest/'FSRCNN_x2.pb').write_bytes(r.content)
    (dest/'LICENSE-FSRCNN.txt').write_text(license.text, encoding='utf-8')
    print('MODEL',len(r.content), hashlib.sha256(r.content).hexdigest(),flush=True)

if __name__=='__main__':
    jobs=[
        ('webb','https://spacetelescopelive.org/api/get/webb', {'headers':{'endpoint':'current'}}),
        ('hubble','https://spacetelescopelive.org/api/get/hubble', {'headers':{'endpoint':'current'}}),
        ('requested','https://spacetelescopelive.org/api/get/webb', {'headers':{'endpoint':'01M0T4XYBKBP63HYG18QQ1QT8S'}}),
        ('surveys','https://alasky.cds.unistra.fr/MocServer/query', {'params':{'expr':'dataproduct_type=image && (obs_title=*JWST* || obs_title=*Hubble* || obs_title=*Halpha* || obs_title=*Finkbeiner*)','get':'record','fmt':'json'}}),
        ('mast','https://mast.stsci.edu/api/v0/invoke', {'params':{'request':json.dumps({'service':'Mast.Caom.Cone','params':{'ra':83.82208,'dec':-5.39111,'radius':0.05},'format':'json','pagesize':100,'page':1})}}),
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        fs=[pool.submit(probe,n,u,**k) for n,u,k in jobs]
        fs.append(pool.submit(model))
        for f in fs: f.result()
