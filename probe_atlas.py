import json
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from range_fits import RangeFITS
import recent_archive

for ident in ['1167721488','1208797559']:
    o=recent_archive.observation(ident)
    try:
        with RangeFITS(o['dataURL']) as remote:
            with fits.open(remote,memmap=False,lazy_load_hdus=True) as hdus:
                hdu=next(h for h in hdus if h.name=='SCI' and h.header.get('NAXIS')==2)
                w=WCS(hdu.header,fobj=hdus).celestial
                x,y=w.world_to_pixel_values(o['s_ra'],o['s_dec']);x,y=int(x),int(y)
                a=hdu.section[max(0,y-128):y+128,max(0,x-128):x+128]
                print(json.dumps({'id':ident,'uri':o['dataURL'],'shape':hdu.shape,'wcs':w.has_celestial,'cutout':a.shape,'finite':int(np.isfinite(a).sum()),'bytes_read':remote.transferred,'total_bytes':remote.size,'requests':remote.requests}))
    except Exception as e:print(json.dumps({'id':ident,'error':str(e)}))
