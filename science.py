"""Local image processing; candidate analysis always reads original data."""
import csv
import hashlib
import io
import json
import math
import uuid
from pathlib import Path

import cv2
import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.timeseries import BoxLeastSquares
from astropy.wcs import WCS
from PIL import Image, ImageDraw, PngImagePlugin
from scipy import ndimage

ROOT=Path(__file__).parent
IMAGES=ROOT/'data'/'images'
IMAGES.mkdir(parents=True, exist_ok=True)
MODEL_SHA='366b33f0084c7b3f2bf6724f0a2c77bca94fcec9d7b6d72389d330073b380d5c'
Image.MAX_IMAGE_PIXELS=25_000_000

def meta_path(image_id):
    if len(image_id)!=32 or any(c not in '0123456789abcdef' for c in image_id):
        raise ValueError('Invalid image identifier.')
    return IMAGES/(image_id+'.json')

def metadata(image_id):
    p=meta_path(image_id)
    if not p.exists():
        raise ValueError('Image not found.')
    return json.loads(p.read_text(encoding='utf-8'))

def save_metadata(m):
    meta_path(m['id']).write_text(json.dumps(m, allow_nan=False, indent=2), encoding='utf-8')

def stretch_array(arr, mode='asinh'):
    valid=arr[np.isfinite(arr)]
    if not valid.size:
        raise ValueError('The image contains no finite pixels.')
    low,high=np.percentile(valid[::max(1,valid.size//1_000_000)], [1,99.8])
    if high<=low:
        high=low+1
    scaled=np.clip((np.nan_to_num(arr,nan=float(low),posinf=float(high),neginf=float(low))-low)/(high-low),0,1)
    if mode=='asinh':
        scaled=np.arcsinh(10*scaled)/np.arcsinh(10)
    elif mode=='log':
        scaled=np.log1p(100*scaled)/np.log(101)
    elif mode!='linear':
        raise ValueError('Unknown stretch.')
    return (scaled*255).astype(np.uint8)

def import_image(content, filename, source='Local upload', extra=None):
    if not content or len(content)>100*1024*1024:
        raise ValueError('Choose an image between 1 byte and 100 MB.')
    image_id=uuid.uuid4().hex
    is_fits=filename.lower().endswith(('.fits','.fit','.fts','.fits.gz')) or content.startswith(b'SIMPLE  =')
    m={'id':image_id,'name':Path(filename).name[:220], 'source':source,
       'sha256':hashlib.sha256(content).hexdigest(),'scientific':is_fits,
       'original_url':f'/api/images/{image_id}/original','preview_url':f'/api/images/{image_id}/preview',
       'extra':extra or {},'ai':None}
    if is_fits:
        with fits.open(io.BytesIO(content), memmap=False) as hdus:
            possible=[h for h in hdus if isinstance(h,(fits.PrimaryHDU,fits.ImageHDU,fits.CompImageHDU)) and h.header.get('NAXIS')==2]
            possible.sort(key=lambda h: h.name!='SCI')
            if not possible:
                raise ValueError('Choose a 2D image FITS. Light-curve FITS belongs in the Transit lab; spectral cubes need a selected slice.')
            hdu=possible[0]
            m['hdu_index']=next(i for i,h in enumerate(hdus) if h is hdu)
            if hdu.header.get('NAXIS1',0)*hdu.header.get('NAXIS2',0)>25_000_000:
                raise ValueError('This FITS image exceeds 25 million pixels. Crop the original before importing.')
            arr=np.array(hdu.data,dtype=np.float64)
            hdr=hdu.header.copy()
            m['hdu']=hdu.name
            m['unit']=hdr.get('BUNIT','Not specified')
            m['filter']=hdr.get('FILTER',hdr.get('FILTER1','Not specified'))
            m['instrument']=hdr.get('INSTRUME',hdus[0].header.get('INSTRUME','Not specified'))
            m['filter']=hdus[0].header.get('FILTER', m['filter'])
            m['telescope']=hdr.get('TELESCOP',hdus[0].header.get('TELESCOP','Not specified'))
            try:
                image_wcs=WCS(hdr,fobj=hdus)
                m['wcs']=bool(image_wcs.has_celestial)
            except (ValueError,KeyError,TypeError):
                image_wcs=None
                m['wcs']=False
                m['wcs_note']='Celestial WCS could not be interpreted. Pixel coordinates remain available.'
            if m['wcs']:
                ra,dec=image_wcs.celestial.pixel_to_world_values((arr.shape[1]-1)/2,(arr.shape[0]-1)/2)
                if np.isfinite(ra) and np.isfinite(dec): m['center']={'ra':float(ra)%360,'dec':float(dec)}
            hdr.tofile(str(IMAGES/(image_id+'.hdr')), sep='\n', padding=False, overwrite=True)
        m['height'],m['width']=arr.shape
        m['extension']='.fits'
        np.save(IMAGES/(image_id+'.npy'),arr,allow_pickle=False)
        preview=Image.fromarray(np.flipud(stretch_array(arr))).convert('RGB')
    else:
        try:
            with Image.open(io.BytesIO(content)) as image:
                if image.width*image.height>25_000_000:
                    raise ValueError('Image exceeds 25 million pixels.')
                preview=image.convert('RGB')
                m['format']=image.format
        except (OSError,Image.DecompressionBombError) as e:
            raise ValueError('Choose a supported PNG, JPEG, TIFF, or FITS image.') from e
        m['width'],m['height']=preview.size
        m['extension']={"PNG":'.png',"JPEG":'.jpg',"TIFF":'.tiff',"WEBP":'.webp'}.get(m['format'],'.bin')
        m['wcs']=False
    m['original_file']=image_id+m['extension'] if is_fits else image_id+'-original'+m['extension']
    (IMAGES/m['original_file']).write_bytes(content)
    preview.thumbnail((1600,1600))
    preview.save(IMAGES/(image_id+'.png'))
    m['preview_width'],m['preview_height']=preview.size
    save_metadata(m)
    return m

def render(image_id,mode):
    m=metadata(image_id)
    if not m['scientific']:
        return IMAGES/(image_id+'.png')
    arr=np.load(IMAGES/(image_id+'.npy'), allow_pickle=False)
    im=Image.fromarray(np.flipud(stretch_array(arr,mode))).convert('RGB')
    im.thumbnail((1600,1600))
    path=IMAGES/(image_id+'-'+mode+'.png')
    im.save(path)
    return path

def enhance(image_id):
    m=metadata(image_id)
    path=ROOT/'models'/'FSRCNN_x2.pb'
    if not path.exists():
        raise ValueError('The local FSRCNN model is missing. Run Setup.cmd.')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=MODEL_SHA:
        raise ValueError('The local model checksum does not match the bundled model manifest.')
    image=Image.open(IMAGES/(image_id+'.png')).convert('RGB')
    image.thumbnail((1200,1200))
    sr=cv2.dnn_superres.DnnSuperResImpl_create()
    sr.readModel(str(path))
    sr.setModel('fsrcnn',2)
    cv2.setNumThreads(4)
    result=sr.upsample(cv2.cvtColor(np.array(image),cv2.COLOR_RGB2BGR))
    im=Image.fromarray(cv2.cvtColor(result,cv2.COLOR_BGR2RGB))
    # Label the pixels in the exported artifact as well as the UI.
    draw=ImageDraw.Draw(im)
    label='AI ENHANCED - VISUALIZATION ONLY - FSRCNN 2x'
    box=draw.textbbox((0,0),label)
    draw.rectangle((4,im.height-25,box[2]+16,im.height-4), fill='black')
    draw.text((10,im.height-22),label,fill='white')
    pnginfo=PngImagePlugin.PngInfo()
    pnginfo.add_text('Provenance',json.dumps({'model':'FSRCNN x2','input_sha256':m['sha256'],'scientific_evidence':False}))
    im.save(IMAGES/(image_id+'-ai.png'),pnginfo=pnginfo)
    m=metadata(image_id)
    m['ai']={'model':'FSRCNN x2','model_sha256':MODEL_SHA,'input_size':list(image.size),'output_size':list(im.size),
             'url':f'/api/images/{image_id}/ai','note':'Local CPU neural upscaling of the display preview. May invent or distort details. No new measurements; not used for source detection.'}
    save_metadata(m)
    return m

def detect_sources(image_id,sigma=6.0):
    m=metadata(image_id)
    if not m['scientific']:
        raise ValueError('Source detection requires an original 2D FITS image. Display composites and AI outputs are not measurement data.')
    arr=np.load(IMAGES/(image_id+'.npy'),allow_pickle=False)
    valid=np.isfinite(arr)
    filled=np.where(valid,arr,np.nanmedian(arr))
    background=ndimage.gaussian_filter(filled,sigma=12)
    residual=filled-background
    sample=residual[valid][::max(1,int(valid.sum())//500_000)]
    _,median,noise=sigma_clipped_stats(sample,sigma=3,maxiters=5)
    if not np.isfinite(noise) or noise<=0:
        raise ValueError('Cannot estimate a finite background noise level.')
    threshold=median+sigma*noise
    peaks=(residual==ndimage.maximum_filter(residual,size=7)) & (residual>threshold) & valid
    peaks[:10,:]=False; peaks[-10:,:]=False; peaks[:,:10]=False; peaks[:,-10:]=False
    ys,xs=np.where(peaks)
    order=np.argsort(residual[ys,xs])[::-1]
    wcs=None
    if m['wcs']:
        # Read WCS from the exact original HDU, including any distortion lookup tables.
        with fits.open(IMAGES/(image_id+m['extension']),memmap=False) as hdus:
            hdu=hdus[m.get('hdu_index',m['hdu'])]
            wcs=WCS(hdu.header,fobj=hdus).celestial
    rows=[]
    yy,xx=np.mgrid[-9:10,-9:10]
    rr=np.sqrt(xx**2+yy**2)
    aperture=rr<=3
    annulus=(rr>=6)&(rr<=9)
    for i in order[:1500]:
        x,y=int(xs[i]),int(ys[i])
        patch=residual[y-2:y+3,x-2:x+3]
        if np.sum(patch>sigma*noise/2)<3:
            continue
        raw=arr[y-9:y+10,x-9:x+10]
        sky=float(np.nanmedian(raw[annulus]))
        net=float(np.nansum(raw[aperture]-sky))
        row={'id':len(rows)+1,'x':x,'y':y,'display_x':x,'display_y':arr.shape[0]-1-y,
             'peak_sigma':round(float(residual[y,x]/noise),2),'aperture_net':round(net,5),'ra':None,'dec':None}
        if wcs:
            try:
                ra,dec=wcs.pixel_to_world_values(float(x),float(y))
                if np.isfinite(ra) and np.isfinite(dec):
                    row.update(ra=float(ra)%360,dec=float(dec))
            except Exception:
                pass
        rows.append(row)
        if len(rows)>=200: break
    report={'image_id':image_id,'input_sha256':m['sha256'],'rows':rows,'sigma_threshold':sigma,
            'background_sigma':float(noise),'unit':m.get('unit'),'wcs':m['wcs'],
            'note':'Unclassified peaks from original FITS, capped at 200. Approximate background and 3-pixel aperture sums, not calibrated photometry or confirmed stars. Verify PSF, DQ flags, repeat exposures, and catalogs.'}
    (IMAGES/(image_id+'-candidates.json')).write_text(json.dumps(report,allow_nan=False,indent=2),encoding='utf-8')
    return report

def parse_lightcurve(content,filename):
    if filename.lower().endswith(('.fits','.fit','.fits.gz')) or content.startswith(b'SIMPLE  ='):
        with fits.open(io.BytesIO(content),memmap=False) as hdus:
            h=next((h for h in hdus if isinstance(h,fits.BinTableHDU) and 'TIME' in h.columns.names),None)
            if h is None:
                raise ValueError('No TIME table found. Use a TESS/Kepler light-curve FITS or time,flux CSV.')
            columns=h.columns.names
            col=next((c for c in ['PDCSAP_FLUX','SAP_FLUX','FLUX'] if c in columns),None)
            if not col:
                raise ValueError('No PDCSAP_FLUX, SAP_FLUX, or FLUX column found.')
            t=np.array(h.data['TIME'],dtype=float)
            y=np.array(h.data[col],dtype=float)
            quality=next((c for c in ['QUALITY','SAP_QUALITY'] if c in columns),None)
            good=(h.data[quality]==0) if quality else np.ones(t.size,dtype=bool)
            return t[good],y[good],col
    try:
        data=np.genfromtxt(io.StringIO(content.decode('utf-8-sig')),delimiter=',',names=True,dtype=float)
        names={n.lower():n for n in data.dtype.names or []}
        return np.atleast_1d(data[names['time']]),np.atleast_1d(data[names['flux']]),'flux'
    except Exception as e:
        raise ValueError('CSV must have headers time,flux, with time in days.') from e

def transit_search(content,filename,min_period=0.5,max_period=15):
    t,y,col=parse_lightcurve(content,filename)
    good=np.isfinite(t)&np.isfinite(y)&(y>0)
    t,y=t[good],y[good]
    if t.size<100 or t.size>500_000:
        raise ValueError('Use 100 to 500,000 valid light-curve samples.')
    order=np.argsort(t); t,y=t[order],y[order]
    unique=np.r_[True,np.diff(t)>0]; t,y=t[unique],y[unique]
    y=y/np.median(y)
    span=float(np.ptp(t)); max_period=min(max_period,span/2)
    if max_period<=min_period:
        raise ValueError('Time baseline must span at least twice your minimum period.')
    # A robust running-median trend; window spans ~1 day at the median cadence.
    cadence=float(np.median(np.diff(t)))
    window=min(1001,max(31,int(1.0/max(cadence,1e-6))|1))
    window=min(window,(len(y)//2)*2-1)
    trend=ndimage.median_filter(y,size=window,mode='nearest')
    flat=y/np.maximum(trend,1e-12)
    periods=np.geomspace(min_period,max_period,3500)
    durations=np.array([0.04,0.08,0.12,0.2])
    durations=durations[durations<min_period/2]
    if not durations.size:
        durations=np.array([min_period/5])
    bls=BoxLeastSquares(t,flat)
    result=bls.power(periods,durations,objective='likelihood')
    ix=int(np.argmax(result.power))
    period=float(result.period[ix]); duration=float(result.duration[ix]); epoch=float(result.transit_time[ix])
    phase=((t-epoch+period/2)%period)-period/2
    stride=max(1,len(t)//3000)
    return {'name':Path(filename).name,'column':col,'samples':len(t),'baseline_days':span,
            'detrend_window_days':window*cadence,
            'period_days':period,'duration_hours':duration*24,'depth':float(result.depth[ix]),'epoch':epoch,
            'input_sha256':hashlib.sha256(content).hexdigest(),'minimum_period':min_period,'maximum_period':max_period,
            'time':t[::stride].tolist(),'flux':flat[::stride].tolist(),'phase':phase[::stride].tolist(),
            'periods':periods[::5].tolist(),'power':result.power[::5].tolist(),
            'note':'Exploratory box least squares fit after a running median detrend. The highest peak is not a confirmed planet or detection significance. Check gaps, period aliases, eclipsing binaries, contamination, and independent sectors.'}
