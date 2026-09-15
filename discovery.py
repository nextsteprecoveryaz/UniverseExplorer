"""Quality-aware exploratory measurements from original local FITS images."""
import hashlib
import json
import math
import warnings
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.time import Time
from astropy.stats import sigma_clipped_stats
from astropy.table import Table
from photutils.background import Background2D,MedianBackground
from photutils.detection import DAOStarFinder
from photutils.psf import PSFPhotometry,CircularGaussianPRF,SourceGrouper
from photutils.psf import decode_psf_flags
from scipy.ndimage import binary_dilation
import science
from integrations import now,number

def read_original(image_id):
    m=science.metadata(image_id)
    if not m['scientific']:raise ValueError('Choose an original FITS image. AI images and display composites are not measurement inputs.')
    p=science.IMAGES/m.get('original_file',image_id+m['extension'])
    hdus=fits.open(p,memmap=False);h=hdus[m.get('hdu_index',0)]
    if h.header.get('VISONLY'):hdus.close();raise ValueError('This FITS is a resampled display cutout. Import the original product for source measurements.')
    arr=np.array(h.data,dtype=float);header=h.header
    if arr.ndim!=2:hdus.close();raise ValueError('Choose a two-dimensional science image.')
    ver=header.get('EXTVER',1)
    def plane(name):
        return next((x for x in hdus if x.name==name and x.header.get('EXTVER',1)==ver and x.shape==arr.shape),None)
    dq=plane('DQ');err=plane('ERR');bad=~np.isfinite(arr)
    if dq is not None:bad|=np.asarray(dq.data)!=0
    uncertainty=np.array(err.data,dtype=float) if err is not None else None
    if uncertainty is not None:bad|=~np.isfinite(uncertainty)|(uncertainty<=0)
    try:w=WCS(header,fobj=hdus).celestial
    except Exception:w=None
    rawdate=hdus[0].header.get('EXPSTART',header.get('MJD-OBS'))
    return hdus,m,arr,bad,uncertainty,w,{'dq_applied':dq is not None,'error_plane':err is not None,'hdu':h.name,'extver':ver,'unit':header.get('BUNIT',m.get('unit')),'epoch_mjd':number(rawdate)}

def analyze(image_id,threshold=6,fwhm=2.5,limit=150):
    hdus,m,data,bad,error,w,info=read_original(image_id)
    try:
        good=~bad
        if good.sum()<100:raise ValueError('Too few valid pixels after detector-quality masking.')
        _,med,rms=sigma_clipped_stats(data,mask=bad,sigma=3)
        if not np.isfinite(rms) or rms<=0:raise ValueError('No finite background noise estimate.')
        box=max(16,min(64,min(data.shape)//4))
        try:
            bg=Background2D(data,(box,box),mask=bad,filter_size=(3,3),bkg_estimator=MedianBackground(),exclude_percentile=70)
            background=bg.background;noise=bg.background_rms
        except ValueError:background=np.full_like(data,med);noise=np.full_like(data,rms)
        residual=np.where(bad,0,data-background)
        # ERR usually includes instrumental noise; do not count it twice.
        error=np.where(bad,rms,error) if error is not None else np.maximum(noise,rms*.1)
        mask=binary_dilation(bad,iterations=1);mask[:6]=True;mask[-6:]=True;mask[:,:6]=True;mask[:,-6:]=True
        finder=DAOStarFinder(threshold=threshold*float(np.median(noise[good])),fwhm=fwhm,min_separation=fwhm,exclude_border=True)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore');detected=finder(residual,mask=mask)
        rows=[]
        if detected is not None and len(detected):
            detected.sort('flux',reverse=True);detected=detected[:limit]
            init=Table({'x_init':detected['x_centroid'],'y_init':detected['y_centroid'],'flux_init':np.maximum(detected['flux'],rms)})
            model=CircularGaussianPRF(fwhm=fwhm)
            fit=PSFPhotometry(model,fit_shape=11,grouper=SourceGrouper(2*fwhm),aperture_radius=max(3,fwhm*1.5),xy_bounds=2.5)
            with warnings.catch_warnings():
                warnings.simplefilter('ignore');result=fit(residual,error=error,mask=mask,init_params=init)
            for i,r in enumerate(result):
                def val(k):
                    value=float(r[k]) if k in result.colnames else float('nan')
                    return value if math.isfinite(value) else None
                x,y=val('x_fit'),val('y_fit');flux,fluxerr=val('flux_fit'),val('flux_err')
                if x is None or y is None:continue
                flags=int(r['flags']);ra=dec=None
                if w and w.has_celestial:
                    p=w.pixel_to_world(x,y).icrs;ra=float(p.ra.deg);dec=float(p.dec.deg)
                rows.append({'id':i+1,'x':x,'y':y,'display_x':x,'display_y':data.shape[0]-1-y,'ra':ra,'dec':dec,'flux':flux,'flux_error':fluxerr,'snr':flux/fluxerr if flux is not None and fluxerr and fluxerr>0 else None,'x_error':val('x_err'),'y_error':val('y_err'),'fit_flags':flags,'qfit':val('qfit'),'cfit':val('cfit'),'group':int(r['group_id']) if 'group_id' in result.colnames else None,'status':'Review fit flags' if flags else 'Unconfirmed source candidate'})
        report={'image_id':image_id,'input_sha256':m['sha256'],'created_at':now(),'rows':rows,'threshold':threshold,'fwhm_pixels':fwhm,'masked_fraction':float(bad.mean()),'background_rms':float(np.median(noise[good])),**info,'method':'DAO detection and simultaneous grouped Gaussian-PRF fitting with Photutils. All nonzero DQ flags masked; one-pixel mask margin. Fixed user-selected FWHM.','limits':'Exploratory fluxes in image units, not calibrated magnitudes or discovery probabilities. Gaussian PRF approximates the instrument. ERR uncertainties may omit resampling correlations and systematics; without ERR, estimates use background noise only and omit source Poisson noise. Independent images and catalog checks are still required.'}
        for row in rows:row['fit_issues']=decode_psf_flags(row['fit_flags'])
        report.update(width=m['width'],height=m['height'],name=m['name'],preview_url=m['preview_url'],original_url=m['original_url'],fit_limit=limit)
        if w and w.has_celestial:
            center=w.pixel_to_world((m['width']-1)/2,(m['height']-1)/2).icrs
            report['center']={'ra':float(center.ra.deg),'dec':float(center.dec.deg)}
        path=science.IMAGES/(image_id+'-evidence.json');temp=path.with_suffix('.json.tmp');temp.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf-8');temp.replace(path)
        return report
    finally:hdus.close()

def repeat_check(first,second,radius=1):
    # Match independent originals geometrically; report rather than infer novelty.
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    science.metadata(first);science.metadata(second)
    try:a=json.loads((science.IMAGES/(first+'-evidence.json')).read_text());b=json.loads((science.IMAGES/(second+'-evidence.json')).read_text())
    except FileNotFoundError:raise ValueError('Analyze both originals before checking repeat detections.')
    if a['input_sha256']==b['input_sha256']:raise ValueError('Choose two different original files.')
    ar=[r for r in a['rows'] if r['ra'] is not None];br=[r for r in b['rows'] if r['ra'] is not None]
    if not ar or not br:raise ValueError('Both reports need celestial coordinates.')
    ac=SkyCoord([r['ra'] for r in ar]*u.deg,[r['dec'] for r in ar]*u.deg);bc=SkyCoord([r['ra'] for r in br]*u.deg,[r['dec'] for r in br]*u.deg)
    ix,sep,_=ac.match_to_catalog_sky(bc)
    rows=[{'first_id':r['id'],'second_id':br[int(j)]['id'] if s.arcsec<=radius else None,'separation_arcsec':float(s.arcsec),'within_radius':bool(s.arcsec<=radius)} for r,j,s in zip(ar,ix,sep)]
    for r in rows:r['ambiguous']=r['second_id'] is not None and sum(x['second_id']==r['second_id'] for x in rows)>1
    return {'first':first,'second':second,'rows':rows,'radius_arcsec':radius,'epoch_mjd':[a['epoch_mjd'],b['epoch_mjd']],'note':'Positional association only. Different files may share exposures. Motion, astrometric errors, blends and differing filters affect matches; absence is not a discovery or a disappearance.'}
