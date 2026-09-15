"""Small display cutouts from original FITS WCS; no generated image content."""
import hashlib
import io
import math
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from astropy.coordinates import SkyCoord
from scipy.ndimage import map_coordinates
from range_fits import RangeFITS

def view_header(ra,dec,fov,size=768):
    # TAN cannot represent a hemisphere. Wide downloaded views use AIT.
    projection='TAN' if fov<120 else 'AIT'
    span=math.degrees(2*math.tan(math.radians(fov/2))) if projection=='TAN' else math.degrees(4*math.sqrt(2))*fov/360
    scale=span/size
    return {'NAXIS':2,'NAXIS1':size,'NAXIS2':size,'CTYPE1':'RA---'+projection,'CTYPE2':'DEC--'+projection,'CUNIT1':'deg','CUNIT2':'deg','RADESYS':'ICRS','EQUINOX':2000.,'CRVAL1':ra,'CRVAL2':dec,'CRPIX1':(size+1)/2,'CRPIX2':(size+1)/2,'CD1_1':-scale,'CD1_2':0.,'CD2_1':0.,'CD2_2':scale}

def reproject_section(hdu,wcs,ra,dec,fov,size=512,native_limit=640,grid=None,dq=None):
    if len(hdu.shape)!=2 or not wcs.has_celestial:raise ValueError('This product does not contain a supported two-dimensional celestial image.')
    height,width=hdu.shape
    native_scale=float(np.min(np.abs(proj_plane_pixel_scales(wcs.celestial))))
    if not math.isfinite(native_scale) or native_scale<=0:raise ValueError('The FITS pixel scale is invalid.')
    # Keep the native crop small even when a mosaic is several GB.
    # Range transfers include adjacent row bytes and may still hit the hard budget.
    span=min(max(fov,native_scale*64),native_scale*native_limit)
    if grid is not None:
        header=dict(grid);size=header['NAXIS1'];span=abs(header['CD1_1'])*size
    else:header=view_header(ra,dec,span,size)
    output_wcs=WCS(header)
    yy,xx=np.mgrid[:size,:size];world=output_wcs.pixel_to_world(xx,yy)
    sx,sy=wcs.celestial.world_to_pixel(world)
    valid=np.isfinite(sx)&np.isfinite(sy)&(sx>=0)&(sy>=0)&(sx<=width-1)&(sy<=height-1)
    if not valid.any():raise ValueError('The requested position falls outside this science image.')
    x0=max(0,int(np.floor(sx[valid].min()))-1);x1=min(width,int(np.ceil(sx[valid].max()))+2)
    y0=max(0,int(np.floor(sy[valid].min()))-1);y1=min(height,int(np.ceil(sy[valid].max()))+2)
    if (x1-x0)*(y1-y0)>4_000_000:raise ValueError('Distortion expands this cutout beyond the memory budget. Zoom closer.')
    raw=np.asarray(hdu.section[y0:y1,x0:x1],dtype=np.float32)
    finite=np.isfinite(raw)
    if dq is not None:finite&=np.asarray(dq.section[y0:y1,x0:x1])==0
    coords=np.array([np.where(valid,sy-y0,-10),np.where(valid,sx-x0,-10)])
    weight=map_coordinates(finite.astype(np.float32),coords,order=1,mode='constant',cval=0,prefilter=False)
    result=map_coordinates(np.where(finite,raw,0),coords,order=1,mode='constant',cval=0,prefilter=False)
    # Require a fully valid interpolation footprint; never fill missing data.
    good=valid&(weight>.9999);result[~good]=np.nan
    if not good.any():raise ValueError('No finite science pixels were returned at this position.')
    lo,hi=np.percentile(result[good],[.5,99.5]).tolist()
    if hi<=lo:hi=lo+max(abs(lo)*1e-6,1e-6)
    hdr=fits.Header(header);hdr['VISONLY']=(True,'Display only; not flux-conserving')
    processing='Bilinear WCS display reprojection; no AI; not flux-conserving. '+('All nonzero DQ flags masked.' if dq is not None else 'No DQ plane applied.')+' Original FITS is required for measurements.'
    hdr.add_history(processing)
    if hdu.header.get('BUNIT'):hdr['BUNIT']=hdu.header['BUNIT']
    content=io.BytesIO();fits.PrimaryHDU(result,header=hdr).writeto(content)
    rx,ry=wcs.celestial.world_to_pixel(wcs.celestial.pixel_to_world(sx[good][::4096],sy[good][::4096]))
    residual=float(np.max(np.hypot(rx-sx[good][::4096],ry-sy[good][::4096])))
    meta={'wcs':header,'ra':ra,'dec':dec,'fov':span,'width':size,'height':size,'source_shape':[height,width],'source_section':[x0,y0,x1,y1],'native_pixel_scale_arcsec':native_scale*3600,'finite_fraction':float(good.mean()),'min_cut':lo,'max_cut':hi,'wcs_roundtrip_pixels':residual,'source_section_sha256':hashlib.sha256(raw.tobytes()).hexdigest(),'processing':processing,'dq_applied':dq is not None,'unit':hdu.header.get('BUNIT')}
    return content.getvalue(),meta

def from_archive(observation,ra,dec,fov,reader_factory=RangeFITS,size=512,native_limit=640,grid=None,apply_dq=False):
    uri=observation.get('dataURL')
    if not uri:raise ValueError('This observation has no direct science FITS product. Use its archive product list.')
    with reader_factory(uri) as remote:
        with fits.open(remote,memmap=False,lazy_load_hdus=True) as hdus:
            chosen=None
            chosen_wcs=None;fallback=None
            for h in hdus:
                if h.header.get('NAXIS')!=2 or h.header.get('EXTNAME','').upper()!='SCI':continue
                if fallback is None:fallback=h
                try:
                    candidate=WCS(h.header,fobj=hdus)
                    px,py=candidate.celestial.world_to_pixel(SkyCoord(ra,dec,unit='deg',frame='icrs'))
                    if np.isfinite(px) and np.isfinite(py) and 0<=px<h.shape[1] and 0<=py<h.shape[0]:chosen=h;chosen_wcs=candidate;break
                except (ValueError,TypeError):continue
            if chosen is None:chosen=fallback
            if chosen is None:
                chosen=next((h for h in hdus if h.header.get('NAXIS')==2),None)
            if chosen is None:raise ValueError('No supported 2D science image is available in this FITS product.')
            wcs=chosen_wcs if chosen_wcs is not None else WCS(chosen.header,fobj=hdus)
            dq=next((h for h in hdus if h.name=='DQ' and h.header.get('EXTVER',1)==chosen.header.get('EXTVER',1) and h.shape==chosen.shape),None) if apply_dq else None
            content,meta=reproject_section(chosen,wcs,ra,dec,fov,size=size,native_limit=native_limit,grid=grid,dq=dq)
            meta.update({'source_uri':uri,'source_hdu':chosen.name,'source_etag':remote.etag,'source_bytes':remote.size,'downloaded_bytes':remote.transferred,'range_requests':remote.requests})
    meta.update({'record_id':str(observation['record_id']),'observation':observation.get('obs_id'),'mission':observation.get('obs_collection'),'filters':observation.get('filters'),'observed_mjd':observation.get('t_min'),'sha256':hashlib.sha256(content).hexdigest()})
    return content,meta
