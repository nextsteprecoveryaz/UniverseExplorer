import hashlib
import json
from pathlib import Path
import httpx

ROOT=Path(__file__).parent
with httpx.Client(base_url='http://127.0.0.1:8765',timeout=160) as c:
    r=c.get('/api/products/24855319');r.raise_for_status();products=r.json()
    print('PRODUCTS',len(products['rows']),json.dumps(products['rows'][:3]),flush=True)
    selected=next((p for p in products['rows'] if p['productFilename']=='n4iy01040_mos.fits'),None)
    if not selected:raise RuntimeError('Expected public NICMOS science product was not returned.')
    library=c.get('/api/images').json()['rows']
    m=next((m for m in library if m['source']==selected['dataURI']),None)
    if m is None:
        r=c.post('/api/images/import',json={'uri':selected['dataURI'],'filename':selected['productFilename'],'observation':{'obsid':24855319,'target':'BN-IRC2','telescope':'HST','filters':'F237M'}})
        r.raise_for_status();m=r.json()
    print('IMPORTED',json.dumps(m),flush=True)
    original=c.get(m['original_url']);original.raise_for_status()
    assert hashlib.sha256(original.content).hexdigest()==m['sha256']
    r=c.post('/api/images/'+m['id']+'/detect');r.raise_for_status();d=r.json()
    print('DETECTED',len(d['rows']),'WCS',d['wcs'],flush=True)
    r=c.get(m['preview_url']);r.raise_for_status();assert r.headers['content-type']=='image/png'
    dest=ROOT/'data'/'verification';dest.mkdir(exist_ok=True)
    (dest/'real-hst-product.json').write_text(json.dumps({'image':m,'candidates':d,'original_hash_verified':True},indent=2),encoding='utf-8')
