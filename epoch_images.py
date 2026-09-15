"""Common-grid epoch displays and bounded, provenance-preserving mosaics."""
import hashlib
import io
import json
import numpy as np
from astropy.io import fits
from scipy.ndimage import gaussian_filter,binary_erosion
from PIL import Image
import atlas_cache as cache
import field_history as history
import sky_cutout
from range_fits import RangeFITS
from integrations import now

def cached(content,mime,meta):
    ident=hashlib.sha256(content).hexdigest();item=cache.put(ident,content,mime,meta)
    return {'id':ident,'url':'/api/atlas/files/'+ident,'bytes':item['size'],**meta}

def png(array,lo=None,hi=None):
    good=np.isfinite(array)
    if not good.any():raise ValueError('No overlapping valid pixels to display.')
    if lo is None:lo,hi=np.percentile(array[good],[1,99.5])
    scaled=np.arcsinh(10*np.clip((np.nan_to_num(array,nan=float(lo))-lo)/max(hi-lo,1e-12),0,1))/np.arcsinh(10)
    rgba=np.zeros((*array.shape,4),dtype=np.uint8);rgba[:,:,:3]=(scaled[:,:,None]*255).astype(np.uint8);rgba[:,:,3]=good*255
    out=io.BytesIO();Image.fromarray(np.flipud(rgba)).save(out,format='PNG');return out.getvalue()

def fetch(o,ra,dec,fov,grid=None,size=768):
    key=cache.key('research-cutout-v1:'+json.dumps([o.get('dataURL'),ra,dec,fov,grid,size],sort_keys=True));item=cache.get(key)
    if item:return item['path'].read_bytes(),item['metadata']
    content,meta=sky_cutout.from_archive(o,ra,dec,fov,reader_factory=lambda uri:RangeFITS(uri,budget=192*1024*1024),size=size,native_limit=1280,grid=grid,apply_dq=True)
    cache.put(key,content,'application/fits',meta);return content,meta

def array(content):return fits.getdata(io.BytesIO(content)).astype(np.float32)

def matched(a,b,fwhm_a,fwhm_b):
    """Broaden both images to the larger specified Gaussian PSF; keep mask edges out."""
    common=max(fwhm_a,fwhm_b);out=[]
    for data,fwhm in [(a,fwhm_a),(b,fwhm_b)]:
        sigma=np.sqrt(max(0,common**2-fwhm**2))/2.354820045
        if sigma>50:raise ValueError('These PSF estimates are too large for the selected field. Use a wider field or verify the arcsecond values.')
        good=np.isfinite(data)
        if sigma>.01:
            blurred=gaussian_filter(np.where(good,data,0),sigma)
            weight=gaussian_filter(good.astype(float),sigma)
            good=binary_erosion(good,iterations=max(1,int(np.ceil(4*sigma))))
            data=np.where(good,blurred/np.maximum(weight,1e-12),np.nan)
        out.append(data)
    return out,common

def compare(ids,ra,dec,fov,psf=None,job=None):
    obs=[history.observation(i) for i in ids];parts=[];grid=None
    if all(o.get('t_min') is not None for o in obs) and obs[0]['t_min']>obs[1]['t_min']:raise ValueError('Choose the older observation as Earlier and the newer as Later.')
    for i,o in enumerate(obs):
        if o.get('mtFlag'):raise ValueError('Moving targets need motion-aware alignment and are excluded.')
        if job:
            if job['cancelled']:raise ValueError('Comparison cancelled.')
            job['progress']=f'Reading original epoch {i+1} of 2'
        content,meta=fetch(o,ra,dec,fov,grid);grid=meta['wcs'];parts.append((array(content),meta))
    reasons=history.compatible(*obs);a,b=[p[0] for p in parts];ma,mb=[p[1] for p in parts]
    same_units=bool(ma.get('unit') and ma['unit']==mb.get('unit'))
    if not same_units:reasons.append('Different or unknown flux units')
    elif str(ma['unit']).strip().lower() in ('counts','count','electrons','electron','adu','dn'):reasons.append('Count images require exposure calibration before brightness comparison')
    # Matching is based on explicit user PSF estimates, never just equal pixel size.
    matching=None
    if psf:
        scale=abs(grid['CD1_1'])*3600
        (a,b),common=matched(a,b,psf[0]/scale,psf[1]/scale)
        matching={'input_fwhm_arcsec':psf,'output_fwhm_arcsec':common*scale,'method':'Gaussian broadening from your PSF estimates, not an instrument PSF calibration.'}
    else:reasons.append('PSF resolution has not been matched')
    good=np.isfinite(a)&np.isfinite(b)
    if good.sum()<100:raise ValueError('The two original products have too little overlapping valid coverage at this position.')
    # Shared brightness only when units agree; incompatible units can compare morphology only.
    lo,hi=np.percentile(np.concatenate((a[good],b[good])),[1,99.5]);images=[]
    for data,meta,o in [(a,ma,obs[0]),(b,mb,obs[1])]:
        cuts=(lo,hi) if same_units else np.percentile(data[good],[1,99.5])
        display=png(np.where(good,data,np.nan),*cuts)
        images.append(cached(display,'image/png',{'source':history.describe(o),'original':meta,'stretch':[float(v) for v in cuts],'shared_stretch':same_units}))
    diff=None
    if not reasons:
        residual=b-a;offset=float(np.median(residual[good]));residual-=offset
        span=float(np.percentile(np.abs(residual[good]),99)) or 1
        rgb=np.zeros((*a.shape,4),dtype=np.uint8);rgb[:,:,:3]=np.nan_to_num(np.clip(.5+residual[:,:,None]/(2*span),0,1),nan=0)*255;rgb[:,:,3]=good*255
        out=io.BytesIO();Image.fromarray(np.flipud(rgb)).save(out,format='PNG')
        diff=cached(out.getvalue(),'image/png',{'background_offset':offset,'range':[-span,span],'method':'Later minus earlier, median offset removed. Same filter, instrument, units, grid and user-estimated Gaussian resolution. No photometric scale fit; no significance or discovery claim.'})
    return {'created_at':now(),'images':images,'difference':diff,'difference_unavailable':reasons,'matching':matching,'wcs':grid,'fov':ma['fov'],'overlap_fraction':float(good.mean()),'note':('Shared brightness stretch. ' if same_units else 'Different units: each image is stretched independently for structure only; brightness is not comparable. ')+'WCS registration uses archive headers; residual astrometric errors may remain. Changes can reflect calibration, PSF or detector artifacts. DQ masking is applied only where a matching DQ plane exists. Download originals for calibrated change measurements.'}

def combine(arrays):
    output=np.full_like(arrays[0],np.nan);source=np.zeros(output.shape,dtype=np.uint8);coverage=np.zeros(output.shape,dtype=np.uint8)
    for i,a in enumerate(arrays):
        good=np.isfinite(a);coverage+=good;take=good&~np.isfinite(output);output[take]=a[take];source[take]=i+1
    return output,source,coverage

def mosaic(ids,ra,dec,fov,job=None):
    obs=[history.observation(i) for i in ids]
    if len({o.get('dataURL') for o in obs})!=len(obs):raise ValueError('Select distinct original products.')
    first=obs[0]
    for o in obs:
        if o.get('mtFlag'):raise ValueError('Moving targets cannot enter a fixed-sky mosaic.')
        if any(not o.get(k) or o[k]!=first.get(k) for k in ('obs_collection','instrument_name','filters')):raise ValueError('Mosaic observations must use the same telescope, instrument and filter.')
    arrays=[];sources=[];grid=None;unit=None
    for i,o in enumerate(obs):
        if job:
            if job['cancelled']:raise ValueError('Mosaic cancelled.')
            job['progress']=f'Original mosaic tile {i+1} of {len(obs)}'
        content,meta=fetch(o,ra,dec,fov,grid,size=1024);grid=meta['wcs']
        if i and (not unit or unit!=meta.get('unit')):raise ValueError('Mosaic flux units differ or are missing.')
        unit=meta.get('unit');arrays.append(array(content));sources.append({'observation':history.describe(o),'cutout':meta})
    output,source,coverage=combine(arrays)
    hdr=fits.Header(grid);hdr['VISONLY']=True
    if unit:hdr['BUNIT']=unit
    hdr.add_history('First valid input pixel wins; no AI, blending or photometric matching. SOURCE identifies input; COVERAGE counts inputs. Display only.')
    buf=io.BytesIO();fits.HDUList([fits.PrimaryHDU(output,hdr),fits.ImageHDU(source,name='SOURCE'),fits.ImageHDU(coverage,name='COVERAGE')]).writeto(buf)
    lo,hi=np.percentile(output[np.isfinite(output)],[.5,99.5])
    meta={'kind':'mosaic','created_at':now(),'ra':ra,'dec':dec,'fov':sources[0]['cutout']['fov'],'wcs':grid,'sources':sources,'min_cut':float(lo),'max_cut':float(hi),'finite_fraction':float(np.isfinite(output).mean()),'overlap_fraction':float((coverage>1).mean()),'processing':'1024-pixel display mosaic. First valid source wins; later sources fill gaps. Same filter and units, possibly different dates. No invented pixels. SOURCE and COVERAGE FITS extensions retain pixel provenance. Not a photometric coadd.'}
    item=cached(buf.getvalue(),'application/fits',meta);item['preview']=cached(png(output),'image/png',{})['url'];return item
