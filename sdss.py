"""SDSS display imagery and quality-masked MaNGA maps from public services."""
import hashlib
import io
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode

import numpy as np
import httpx
from astropy.io import fits
from astropy.wcs import WCS
from fastapi import APIRouter, HTTPException
from PIL import Image, PngImagePlugin
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

import atlas
import atlas_cache as cache
import science
from integrations import now

router=APIRouter(prefix='/api/sdss')
SKYSERVER='https://skyserver.sdss.org/dr20'
MARVIN='https://magrathea.sdss.org/marvin'
BINTYPE='HYB10'
TEMPLATE='MILESHC-MASTARSSP'
POOL=ThreadPoolExecutor(max_workers=2,thread_name_prefix='sdss')
PRODUCTS={
 'ha':{'label':'Hydrogen Hα','property':'emline_gflux','channel':'ha_6564','kind':'flux'},
 'oiii':{'label':'Oxygen [O III]','property':'emline_gflux','channel':'oiii_5008','kind':'flux'},
 'sii':{'label':'Sulfur [S II] 6718','property':'emline_gflux','channel':'sii_6718','kind':'flux'},
 'gas_velocity':{'label':'Hα gas velocity','property':'emline_gvel','channel':'ha_6564','kind':'velocity'},
 'stellar_velocity':{'label':'Stellar velocity','property':'stellar_vel','channel':'None','kind':'velocity'},
 'gas_rgb':{'label':'Gas color composite','kind':'rgb'},
}
SHOWCASES=[
 {'name':'Whirlpool Galaxy · M51','ra':202.469575,'dec':47.1952583,'fov':.23,'description':'A spiral galaxy and its companion in SDSS optical light.'},
 {'name':'MaNGA · 8444-12704','ra':201.762834226,'dec':32.6493084716,'fov':.035,'plateifu':'8444-12704','description':'Compare the galaxy image with spatially resolved spectra.'},
 {'name':'MaNGA · 11835-12705','ra':220.955528951,'dec':1.92599544643,'fov':.03,'plateifu':'11835-12705','description':'The galaxy featured in the MaNGA survey map example.'},
 {'name':'SkyServer showcase','ra':229.525575753,'dec':42.74585376,'fov':.09,'description':'The starting field from the SDSS DR20 Navigate page.'},
]

class Position(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    ra:float=Field(ge=0,lt=360)
    dec:float=Field(ge=-90,le=90)

class Cutout(Position):
    fov:float=Field(default=.23,ge=.01,le=2)
    size:Literal[1024,2048]=2048

class Cone(Position):
    radius:float=Field(default=1,ge=.01,le=5)

class MapRequest(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    plateifu:str=Field(pattern=r'^\d{4,5}-\d{4,5}$')
    product:Literal['ha','oiii','sii','gas_velocity','stellar_velocity','gas_rgb']='ha'
    snr:float=Field(default=3,ge=0,le=20)

class ImportRequest(BaseModel):
    model_config=ConfigDict(extra='forbid')
    ident:str=Field(pattern=r'^[a-f0-9]{64}$')

def cached_bytes(label,url,params=None,max_bytes=8*1024*1024,validate=None):
    ident=cache.key('sdss-remote-v1:'+url+'?'+urlencode(params or {}))
    with cache.LOCK:
        item=cache.get(ident)
        if item:
            raw=item['path'].read_bytes()
            if validate:validate(raw)
            return raw,item['metadata']
    if atlas.CACHED_ONLY:raise ValueError('This SDSS data is not saved yet. Turn off Cached-only atlas to retrieve it.')
    for attempt in range(2):
        try:
            raw,mime=atlas.read_remote(url,params=params,max_bytes=max_bytes)
            break
        except httpx.HTTPStatusError as error:
            status=error.response.status_code
            if attempt==0 and status in (502,503,504):time.sleep(.5);continue
            raise ValueError(f'The SDSS service returned HTTP {status}. Retry the request or choose another observation.') from None
        except httpx.TimeoutException:
            raise ValueError('The SDSS service is taking too long to respond. Retry this field; successfully downloaded data remains cached.') from None
    if validate:validate(raw)
    metadata={'kind':'sdss-source','label':label,'source_url':url+('?' + urlencode(params) if params else ''),'created_at':now(),'sha256':hashlib.sha256(raw).hexdigest()}
    cache.put(ident,raw,mime,metadata)
    return raw,metadata

def remote_json(label,url,params):
    def validate(raw):
        try:result=json.loads(raw)
        except (ValueError,UnicodeError):raise ValueError('The SDSS service did not return a data response. Try again later.') from None
        if isinstance(result,dict) and result.get('status')!=1:raise ValueError('This MaNGA observation or map is unavailable from Marvin. Try another galaxy.')
        if isinstance(result,list) and not any(isinstance(t,dict) and t.get('TableName')=='Table1' for t in result):raise ValueError('The SDSS catalog search is temporarily unavailable.')
        if not isinstance(result,(dict,list)):raise ValueError('Unexpected SDSS data response.')
    raw,provenance=cached_bytes(label,url,params,validate=validate)
    return json.loads(raw),provenance

def json_file(ident):
    with cache.LOCK:
        item=cache.get(ident)
        return json.loads(item['path'].read_bytes()) if item else None

def navigate_url(ra,dec,scale):
    return 'https://skyserver.sdss.org/navigate/?'+urlencode({'ra':ra,'dec':dec,'scale':scale,'dr':20})

def color_cutout(request):
    # Arcseconds per output pixel. A larger output cannot improve native seeing.
    params={'ra':request.ra,'dec':request.dec,'scale':request.fov*3600/request.size,'width':request.size,'height':request.size}
    def validate(raw):
        with Image.open(io.BytesIO(raw)) as im:
            if im.format!='JPEG' or im.size!=(request.size,request.size):raise ValueError('SDSS returned an error image or unexpected dimensions for this field.')
            im.verify()
    raw,source=cached_bytes('SDSS SkyServer DR20 color cutout',SKYSERVER+'/SkyServerWS/ImgCutout/getjpeg',params,validate=validate)
    with Image.open(io.BytesIO(raw)) as im:
        if im.format!='JPEG' or im.size!=(request.size,request.size):raise ValueError('SDSS returned an error image or unexpected dimensions for this field.')
        # SkyServer can return a nearly black image outside the imaging footprint.
        # Report darkness as a hint, not a catalog coverage determination.
        im.load();dark_fraction=float(np.mean(np.max(np.asarray(im.convert('RGB')),axis=2)<8))
    ident=cache.key('sdss-color-v1:'+json.dumps(request.model_dump(),sort_keys=True))
    metadata={'kind':'sdss-color','label':'SDSS optical color · SkyServer DR20','name':f'SDSS-{request.ra:.5f}-{request.dec:.5f}.jpg',
        **request.model_dump(),'source':source,'created_at':source['created_at'],'sha256':hashlib.sha256(raw).hexdigest(),
        'credit':'Sloan Digital Sky Survey / SkyServer','scale_arcsec':params['scale'],'native_pixel_scale_arcsec':.396,
        'processing':'SDSS server-rendered optical color JPEG. DR20 is the access interface; these are legacy imaging observations, not new DR20 exposures. Display colors are not calibrated fluxes.',
        'dark_fraction':dark_fraction,'navigate_url':navigate_url(request.ra,request.dec,params['scale'])}
    cache.put(ident,raw,'image/jpeg',metadata)
    return {**metadata,'id':ident,'url':'/api/atlas/files/'+ident}

def manga_nearby(request):
    # Fixed SQL with validated numeric literals, wrap-safe spherical separation.
    ra,dec,radius=request.ra,request.dec,request.radius
    distance=f'dbo.fDistanceArcMinEq(objra,objdec,{ra:.8f},{dec:.8f})'
    query=f'SELECT TOP 25 plateifu,objra,objdec,nsa_z,nsa_iauname,{distance} AS distance_arcmin FROM mangaDrpAll WHERE {distance}<={radius*60:.8f} ORDER BY distance_arcmin,plateifu'
    tables,source=remote_json('MaNGA DR17 catalog', 'https://skyserver.sdss.org/dr17/SkyServerWS/SearchTools/SqlSearch',{'cmd':query,'format':'json'})
    if not isinstance(tables,list):raise ValueError('The MaNGA catalog search is temporarily unavailable.')
    table=next((t for t in tables if t.get('TableName')=='Table1'),None)
    if table is None:raise ValueError('The MaNGA catalog returned an unexpected response.')
    rows=[]
    for r in table.get('Rows',[])[:25]:
        if not re.fullmatch(r'\d{4,5}-\d{4,5}',str(r.get('plateifu',''))):continue
        rows.append({'plateifu':r['plateifu'],'ra':float(r['objra']),'dec':float(r['objdec']),
                     'redshift':r.get('nsa_z'),'name':r.get('nsa_iauname'),'distance_arcmin':r['distance_arcmin']})
    return {'rows':rows,'limit':25,'at_limit':len(rows)==25,'source':source,'release':'DR17'}

def manga_data(plateifu,product=None):
    url=MARVIN+f'/api/maps/{plateifu}/{BINTYPE}/{TEMPLATE}/'
    if product:
        definition=PRODUCTS[product]
        url+=f"map/{definition['property']}/{definition['channel']}/"
    result,source=remote_json('MaNGA DR17 '+(product or 'metadata'),url,{'release':'DR17'})
    if not isinstance(result,dict) or result.get('status')!=1 or not isinstance(result.get('data'),dict):
        raise ValueError('This MaNGA observation or map is unavailable from Marvin. Try another galaxy.')
    if result.get('inconfig',{}).get('release')!='DR17':raise ValueError('Marvin did not confirm the requested DR17 data release.')
    return result['data'],source

def valid_map(data,shape,snr=0,flux=False):
    value=np.asarray(data['value'],dtype=float);ivar=np.asarray(data['ivar'],dtype=float);mask=np.asarray(data['mask'],dtype=np.int64)
    if value.shape!=shape or ivar.shape!=shape or mask.shape!=shape:raise ValueError('MaNGA map dimensions do not match its metadata.')
    valid=np.isfinite(value)&np.isfinite(ivar)&(ivar>0)&(mask==0)
    if flux:valid&=(value>0)&(value*np.sqrt(np.maximum(ivar,0))>=snr)
    return value,ivar,mask,valid

def flux_stretch(value,valid):
    high=float(np.percentile(value[valid],99)) if valid.any() else 1.
    high=max(high,np.finfo(float).tiny)
    scaled=np.arcsinh(10*np.clip(np.nan_to_num(value,nan=0)/high,0,1))/np.arcsinh(10)
    return scaled,high

def map_pixels(data,definition,shape,snr,ha=None):
    value,ivar,mask,valid=valid_map(data,shape,snr,definition['kind']=='flux')
    if ha is not None:valid&=valid_map(ha,shape,snr,True)[3]
    if not valid.any():raise ValueError('No unflagged measurements pass this signal-to-noise threshold. Lower the threshold or choose another map.')
    if definition['kind']=='velocity':
        bound=max(float(np.percentile(np.abs(value[valid]),98)),1.)
        t=np.clip(np.nan_to_num(value,nan=0)/bound,-1,1)
        rgb=np.stack([1+np.minimum(t,0),1-np.abs(t),1-np.maximum(t,0)],axis=-1)
        limits=[-bound,bound];stretch='linear; symmetric 98th-percentile limits'
    else:
        t,high=flux_stretch(value,valid)
        # Dark violet through magenta and gold to white; intensity is asinh-scaled.
        stops=np.array([[.035,.02,.09],[.25,.04,.38],[.66,.12,.38],[.97,.48,.2],[1,.94,.72]])
        rgb=np.stack([np.interp(t,np.linspace(0,1,len(stops)),stops[:,i]) for i in range(3)],axis=-1)
        limits=[0,high];stretch='asinh; zero to 99th percentile'
    rgba=np.dstack([(np.clip(rgb,0,1)*255).astype('uint8'),valid.astype('uint8')*255])
    return rgba,valid,limits,stretch,value,ivar,mask

def make_manga_map(request):
    ident=cache.key('sdss-manga-v1:'+json.dumps(request.model_dump(),sort_keys=True))
    saved=json_file(ident)
    if saved:
        if cache.get(saved['image_id']) and cache.get(saved['data_id']):return saved
    meta,meta_source=manga_data(request.plateifu)
    if meta.get('plateifu')!=request.plateifu or meta.get('bintype')!=BINTYPE or meta.get('template')!=TEMPLATE:raise ValueError('The MaNGA source identifiers do not match the requested observation.')
    shape=tuple(int(n) for n in meta['shape'])
    if len(shape)!=2 or not all(1<=n<=256 for n in shape):raise ValueError('Unexpected MaNGA spatial dimensions.')
    hdr=fits.Header.fromstring(meta['header']);wcs=WCS(fits.Header.fromstring(meta['wcs'])).celestial
    if not wcs.has_celestial:raise ValueError('MaNGA did not provide valid celestial registration.')
    definition=PRODUCTS[request.product];sources=[meta_source]
    if definition['kind']=='rgb':
        arrays=[];valid=np.ones(shape,dtype=bool);scales={};originals={}
        for product in ('sii','ha','oiii'):
            data,source=manga_data(request.plateifu,product);sources.append(source);originals[product]=data
            value,_,_,good=valid_map(data,shape,request.snr,True);valid&=good
            stretched,high=flux_stretch(value,good);arrays.append(stretched);scales[product]=high
        if not valid.any():raise ValueError('No shared unflagged gas measurements pass this threshold. Lower it or choose an individual line.')
        rgba=np.dstack([(np.stack(arrays,axis=-1)*255).astype('uint8'),valid.astype('uint8')*255])
        limits=None;stretch='Independent asinh channels: R=[S II] 6718, G=Hα, B=[O III]. Not a line-ratio or abundance map.'
        numeric={'channels':originals,'channel_upper_limits':scales};values=None;unit='Assigned display colors'
    else:
        data,source=manga_data(request.plateifu,request.product);sources.append(source);ha=None
        if request.product=='gas_velocity':ha,ha_source=manga_data(request.plateifu,'ha');sources.append(ha_source)
        rgba,valid,limits,stretch,value,ivar,mask=map_pixels(data,definition,shape,request.snr,ha)
        numeric={'map':data};unit=data.get('unit','Not supplied')
        values=np.where(valid,value,np.nan)
        values=[[float(v) if np.isfinite(v) else None for v in row] for row in values]
    header=wcs.to_header();header['NAXIS']=2;header['NAXIS1']=shape[1];header['NAXIS2']=shape[0]
    ra,dec=wcs.pixel_to_world_values((shape[1]-1)/2,(shape[0]-1)/2)
    png=io.BytesIO();info=PngImagePlugin.PngInfo()
    info.add_text('Provenance',json.dumps({'release':'DR17','plateifu':request.plateifu,'product':request.product,'sources':sources,'processing':stretch,'quality':'mask == 0; finite value; positive inverse variance; positive gas flux and requested S/N','snr':request.snr}))
    Image.fromarray(np.flipud(rgba)).save(png,format='PNG',pnginfo=info)
    image_id=cache.key('sdss-map-png:'+ident);data_id=cache.key('sdss-map-data:'+ident)
    result={'id':ident,'image_id':image_id,'data_id':data_id,'url':'/api/atlas/files/'+image_id,'data_url':'/api/atlas/files/'+data_id,
        'kind':'sdss-manga-map','release':'DR17','plateifu':request.plateifu,'product':request.product,'label':definition['label'],
        'ra':float(ra)%360,'dec':float(dec),'width':shape[1],'height':shape[0],'pixel_scale_arcsec':float(np.sqrt(abs(np.linalg.det(wcs.pixel_scale_matrix)))*3600),
        'wcs':dict(header),'unit':unit,'limits':limits,'stretch':stretch,'snr':request.snr,'valid_pixels':int(valid.sum()),'total_pixels':int(valid.size),
        'values':values,'valid':valid.tolist(),'sources':sources,'created_at':now(),'dap_quality':int(hdr.get('DAPQUAL',0)),
        'pipeline':{'drp':str(hdr.get('VERSDRP3','')),'dap':str(hdr.get('VERSDAP','')),'bintype':BINTYPE,'template':TEMPLATE},
        'marvin_url':MARVIN+'/galaxy/'+request.plateifu+'/?release=DR17',
        'credit':'SDSS-IV / MaNGA / Marvin','processing':'Derived visualization of measured spectral maps. Flagged samples are transparent. Native spatial sampling is retained; colors do not measure gas abundance. Velocities are line-of-sight values relative to the pipeline systemic reference.'}
    cache.put(image_id,png.getvalue(),'image/png',{k:v for k,v in result.items() if k not in ('values','valid')})
    numeric.update(metadata=meta,selection={'product':request.product,'snr':request.snr,'valid':valid.tolist()},sources=sources)
    cache.put(data_id,json.dumps(numeric,allow_nan=False).encode(),'application/json',{'kind':'sdss-manga-data'})
    cache.put(ident,json.dumps(result,allow_nan=False).encode(),'application/json',{'kind':'sdss-manga-result'})
    return result

@router.get('/config')
def config():return {'showcases':SHOWCASES,'products':PRODUCTS,'imaging_release':'SkyServer DR20 interface; legacy imaging','manga_release':'DR17'}

@router.post('/cutout')
def cutout(body:Cutout):return atlas.begin('sdss-color-'+cache.key(body.model_dump_json()),lambda job:color_cutout(body),POOL)

@router.post('/manga/nearby')
def nearby(body:Cone):return atlas.begin('sdss-nearby-'+cache.key(body.model_dump_json()),lambda job:manga_nearby(body),POOL)

@router.post('/manga/map')
def map_request(body:MapRequest):return atlas.begin('sdss-map-'+cache.key(body.model_dump_json()),lambda job:make_manga_map(body),POOL)

@router.post('/import')
def import_display(body:ImportRequest):
    with cache.LOCK:
        item=cache.get(body.ident)
        if not item:raise HTTPException(404,'This image is no longer cached. Load it again.')
        if item['metadata'].get('kind') not in ('sdss-color','sdss-manga-map'):raise HTTPException(400,'Choose an SDSS display image.')
        raw=item['path'].read_bytes();metadata=item['metadata']
    name=metadata.get('name') or 'MaNGA-'+metadata['plateifu']+'-'+metadata['product']+'.png'
    return science.import_image(raw,name,source=metadata.get('credit','SDSS'),extra=metadata)
