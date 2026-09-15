"""Live smoke check of SDSS public data through the running local application."""
import hashlib
import io
import json
import time
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

ROOT=Path(__file__).resolve().parent

def main():
    record={'checked_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'maps':[]}
    with httpx.Client(base_url='http://127.0.0.1:8765',timeout=45) as client:
        for survey in ('sdss-color','sdss-g','sdss-r','sdss-i'):
            properties=client.get('/api/atlas/surveys/'+survey+'/properties');properties.raise_for_status()
            assert 'hips_tile_format' in properties.text and 'SDSS' in properties.text
        def job(path,body):
            r=client.post('/api/sdss/'+path,json=body);r.raise_for_status();j=r.json();deadline=time.monotonic()+120
            while j['state'] in ('queued','running'):
                if time.monotonic()>deadline:raise TimeoutError(path)
                time.sleep(.5);r=client.get('/api/atlas/jobs/'+j['id']);r.raise_for_status();j=r.json()
            if j['state']!='complete':raise RuntimeError(j.get('error',j['state']))
            return j['result']
        image=job('cutout',{'ra':202.469575,'dec':47.1952583,'fov':.23,'size':2048})
        r=client.get(image['url']);r.raise_for_status()
        with Image.open(io.BytesIO(r.content)) as im:assert im.size==(2048,2048)
        assert hashlib.sha256(r.content).hexdigest()==image['sha256']
        record['color']={k:image[k] for k in ('id','url','size','source','sha256','scale_arcsec')}
        nearby=job('manga/nearby',{'ra':201.762834226,'dec':32.6493084716,'radius':.05})
        assert any(r['plateifu']=='8444-12704' for r in nearby['rows'])
        record['nearby_count']=len(nearby['rows'])
        for product in ('ha','oiii','sii','gas_velocity','stellar_velocity','gas_rgb'):
            d=job('manga/map',{'plateifu':'8444-12704','product':product,'snr':3})
            r=client.get(d['url']);r.raise_for_status()
            with Image.open(io.BytesIO(r.content)) as im:
                assert im.size==(d['width'],d['height'])
                np.testing.assert_array_equal(np.asarray(im)[:,:,3],np.flipud(d['valid'])*255)
            assert d['valid_pixels']>0 and d['release']=='DR17'
            wcs=WCS(fits.Header(d['wcs'])).celestial
            x,y=(d['width']-1)/2,(d['height']-1)/2;ra,dec=wcs.pixel_to_world_values(x,y)
            xx,yy=wcs.world_to_pixel_values(ra,dec);assert abs(x-xx)<1e-5 and abs(y-yy)<1e-5
            raw=client.get(d['data_url']);raw.raise_for_status();assert raw.json()['metadata']['plateifu']=='8444-12704'
            record['maps'].append({k:d[k] for k in ('product','width','height','valid_pixels','total_pixels','unit','id','url','dap_quality')})
            print(json.dumps(record['maps'][-1]),flush=True)
    target=ROOT/'data'/'verification'/'sdss-live.json';target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(record,indent=2),encoding='utf-8')
    print('SDSS 2048px original, nearby catalog, six measured maps, masks and WCS verified.')

if __name__=='__main__':main()
