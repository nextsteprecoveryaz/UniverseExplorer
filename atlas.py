"""Automatic original-FITS cutouts, trusted survey cache, and saved tour views."""
import io
import json
import re
import threading
import hashlib
import atexit
import logging
import time
from datetime import datetime,timezone
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Literal
from urllib.parse import urlsplit
import httpx
from PIL import Image
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, FileResponse
from pydantic import BaseModel, ConfigDict, Field
import atlas_cache as cache
import coverage_index
import recent_archive
import expeditions
import tour_surveys
from integrations import now
from sky_cutout import from_archive, view_header
from range_fits import RangeFITS

router=APIRouter(prefix='/api/atlas')
SURVEYS={}
JOBS={}
LOCK=threading.Lock()
SCIENCE=ThreadPoolExecutor(max_workers=1,thread_name_prefix='fits-cutout')
DOWNLOADS=ThreadPoolExecutor(max_workers=1,thread_name_prefix='atlas-download')
CACHED_ONLY=False
REMOTE_LOCK=threading.Lock()
REMOTE_CLIENT=None
TILE_LOCK=threading.Lock()
TILE_PENDING={}
TILE_REFRESHING=set()
TILE_REFRESH=ThreadPoolExecutor(max_workers=2,thread_name_prefix='tile-refresh')
TILE_TIMEOUT=httpx.Timeout(18,connect=4,pool=5)
TILE_MIRROR_SECONDS=120
TILE_PREFERRED={}
LOGGER=logging.getLogger('uvicorn.error')
# CDS registry mirrors of the same HiPS, verified against creator_did and tile
# checksums. Keep the canonical URL/cache key even when a mirror supplies bytes.
TILE_MIRRORS={
    'https://alasky.cds.unistra.fr/DSS/DSSColor':('https://alaskybis.cds.unistra.fr/DSS/DSSColor',),
    'https://alasky.cds.unistra.fr/2MASS/Color':('https://alaskybis.cds.unistra.fr/2MASS/Color',),
    'https://alasky.cds.unistra.fr/SDSS/DR9/color':('https://alaskybis.cds.unistra.fr/SDSS/DR9/color',),
    **{'https://alasky.cds.unistra.fr/SDSS/DR9/band-'+band:
       ('https://alaskybis.cds.unistra.fr/SDSS/DR9/band-'+band,) for band in ('g','r','i')},
}

def remote_client():
    """Share persistent connections across tile requests instead of renegotiating TLS."""
    global REMOTE_CLIENT
    with REMOTE_LOCK:
        if REMOTE_CLIENT is None:
            REMOTE_CLIENT=httpx.Client(timeout=httpx.Timeout(90,connect=12,pool=15),follow_redirects=True,
                limits=httpx.Limits(max_connections=24,max_keepalive_connections=16,keepalive_expiry=60))
        return REMOTE_CLIENT

def close_remote_client():
    global REMOTE_CLIENT
    with REMOTE_LOCK:
        client=REMOTE_CLIENT;REMOTE_CLIENT=None
    if client is not None:client.close()

atexit.register(close_remote_client)

class Cutout(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    record_id:str=Field(pattern=r'^\d{1,20}$')
    ra:float=Field(ge=0,lt=360)
    dec:float=Field(ge=-90,le=90)
    fov:float=Field(ge=.0001,le=2)
    quality:Literal[512,1024]=512

class ViewRequest(expeditions.View):pass

class CacheSettings(BaseModel):
    model_config=ConfigDict(extra='forbid')
    limit_gib:Literal[1,4,8,16,32,64]

def public(item):
    return {'id':item['id'],'url':'/api/atlas/files/'+item['id'],'bytes':item['size'],**item['metadata']}

def begin(ident,work,pool):
    with LOCK:
        old=JOBS.get(ident)
        if old and old['state'] in ('queued','running'):return dict(old)
        if sum(j['state'] in ('queued','running') for j in JOBS.values())>=8:raise HTTPException(429,'Download queue is full. Current downloads will finish first.')
        if len(JOBS)>100:
            for k in list(JOBS):
                if JOBS[k]['state'] not in ('queued','running'):del JOBS[k]
        job={'id':ident,'state':'queued','created_at':now(),'cancelled':False};JOBS[ident]=job
    def run():
        try:
            if job['cancelled']:job['state']='cancelled';return
            job['state']='running';job['result']=work(job)
            job['state']='cancelled' if job['cancelled'] else 'complete'
        except Exception as e:job.update(state='failed',error=str(e))
        finally:job['finished_at']=now()
    pool.submit(run)
    return dict(job)

def read_remote(url,params=None,max_bytes=16*1024*1024,*,timeout=None):
    if CACHED_ONLY:raise ValueError('Cached-only mode is on. This view has not been downloaded.')
    data=bytearray()
    options={'timeout':timeout} if timeout is not None else {}
    with remote_client().stream('GET',url,params=params,**options) as r:
        r.raise_for_status()
        for part in r.iter_bytes():
            data.extend(part)
            if len(data)>max_bytes:raise ValueError('The image exceeds the atlas transfer limit.')
        mime=r.headers.get('content-type','application/octet-stream').split(';')[0]
    return bytes(data),mime

def read_tile_remote(url):
    """Try at most two verified sources; failed detail tiles must not stall the map."""
    canonical=next((base for base in TILE_MIRRORS if url.startswith(base+'/')),None)
    sources=[url]
    if canonical:
        suffix=url[len(canonical):]
        sources.extend(base+suffix for base in TILE_MIRRORS[canonical])
        with TILE_LOCK:
            preferred=TILE_PREFERRED.get(canonical)
            if preferred and preferred['until']>time.monotonic():
                chosen=preferred['base']+suffix
                if chosen in sources:sources.remove(chosen);sources.insert(0,chosen)
            elif preferred:TILE_PREFERRED.pop(canonical,None)
    for index,source in enumerate(sources):
        try:
            # Only use a short first attempt when this exact survey has a
            # verified alternate. Other lenses retain their original patience.
            for connection_attempt in range(2):
                try:
                    raw,mime=read_remote(source,timeout=TILE_TIMEOUT if canonical else None)
                    break
                except httpx.RemoteProtocolError:
                    # An idle keep-alive connection may have been closed by
                    # the server. HTTPX discards it; retry this GET once before
                    # abandoning an otherwise responsive source.
                    if connection_attempt:raise
                    LOGGER.warning('Survey tile connection closed: host=%s error=RemoteProtocolError retry_same_host=True',
                        urlsplit(source).hostname)
        except (httpx.TransportError,httpx.HTTPStatusError) as error:
            # A mirror's missing tile is still a valid reply from a reachable
            # survey server. Avoid repeating a dead primary for every empty
            # patch while preserving the 404 and never caching fake imagery.
            if canonical and source!=url and isinstance(error,httpx.HTTPStatusError) and error.response.status_code==404:
                with TILE_LOCK:
                    if not TILE_PREFERRED.get(canonical):
                        TILE_PREFERRED[canonical]={'base':source[:-len(suffix)],'until':time.monotonic()+TILE_MIRROR_SECONDS}
            # Coverage/authorization/client errors retain their exact semantics.
            # Pool exhaustion is local, so switching upstream cannot repair it.
            retryable=(not isinstance(error,httpx.PoolTimeout) and
                       (not isinstance(error,httpx.HTTPStatusError) or error.response.status_code>=500))
            LOGGER.warning('Survey tile fetch failed: host=%s error=%s status=%s retry=%s',
                urlsplit(source).hostname,type(error).__name__,
                error.response.status_code if isinstance(error,httpx.HTTPStatusError) else '-',
                retryable and index+1<len(sources))
            if not retryable or index+1==len(sources):raise
        else:
            if canonical:
                with TILE_LOCK:
                    if source==url:TILE_PREFERRED.pop(canonical,None)
                    elif not TILE_PREFERRED.get(canonical):
                        TILE_PREFERRED[canonical]={'base':source[:-len(suffix)],'until':time.monotonic()+TILE_MIRROR_SECONDS}
            return raw,mime,source

def view_key(view):
    return cache.key('survey-view-v1:'+json.dumps({k:view[k] for k in ('ra','dec','fov','survey')},sort_keys=True))

def require_rendered_views(survey_id):
    survey=SURVEYS.get(survey_id,{})
    if survey.get('rendered_views') is False:
        raise HTTPException(409,'Prepared tour views are unavailable for '+survey.get('name',survey_id)+'. Interactive survey tiles remain available and are cached as you explore.')

def survey_view(view,pin=None):
    require_rendered_views(view['survey'])
    ident=view_key(view);item=cache.get(ident)
    if item:
        if pin:cache.pin(pin,ident)
        return public(item)
    survey=SURVEYS[view['survey']];wcs=view_header(view['ra'],view['dec'],view['fov'])
    raw,_=read_remote('https://alasky.cds.unistra.fr/hips-image-services/hips2fits',{'hips':survey['url'],'wcs':json.dumps(wcs),'format':'png'},8*1024*1024)
    with Image.open(io.BytesIO(raw)) as im:
        if im.size!=(768,768):raise ValueError('The survey service returned unexpected image dimensions.')
        im.verify()
    meta={'kind':'survey-view','survey':view['survey'],'survey_name':survey['name'],'source_url':survey['url'],'ra':view['ra'],'dec':view['dec'],'fov':view['fov'],'wcs':wcs,'created_at':now(),'credit':survey['name']+' · CDS HiPS2FITS','processing':'Saved 768 × 768 rendered survey cutout. Missing survey coverage can appear blank. Not a new telescope exposure or measurement image.'}
    return public(cache.put(ident,raw,'image/png',meta,pin))

@router.get('/status')
def status():
    for p in cache.packs():
        if p['state']=='downloading' and JOBS.get(p['id'],{}).get('state') not in ('queued','running'):
            p['state']='interrupted';cache.save_pack(p)
    return {**cache.status(),'coverage':coverage_index.status(),'cached_only':CACHED_ONLY,'jobs':[dict(j) for j in JOBS.values() if j['state'] in ('queued','running')]}

@router.post('/cached-only')
def cached_only(enabled:bool):
    global CACHED_ONLY
    CACHED_ONLY=enabled
    return {'cached_only':CACHED_ONLY}

@router.post('/cache-settings')
def cache_settings(request:CacheSettings):
    try:return cache.set_limit(request.limit_gib)
    except ValueError as e:raise HTTPException(409,str(e))

@router.get('/files/{ident}')
def file(ident:str):
    try:item=cache.get(ident)
    except ValueError:raise HTTPException(400,'Invalid atlas file.')
    if not item:raise HTTPException(404,'This atlas file is no longer cached.')
    # Read while holding the eviction lock; no path can disappear during the response.
    with cache.LOCK:
        try:data=item['path'].read_bytes()
        except FileNotFoundError:raise HTTPException(404,'This atlas file was evicted. Load the view again.')
    return Response(data,media_type=item['mime'],headers={'Cache-Control':'private, no-cache','ETag':'"'+hashlib.sha256(data).hexdigest()+'"'})

@router.post('/prepare')
def prepare(request:Cutout):
    params=request.model_dump();
    if request.quality==512:params.pop('quality')
    ident=cache.key('science-v1:'+json.dumps(params,sort_keys=True))
    item=cache.get(ident)
    if item:return {'id':ident,'state':'complete','result':public(item)}
    if CACHED_ONLY:raise HTTPException(409,'This science cutout is not cached.')
    observation=recent_archive.observation(request.record_id)
    if observation.get('mtFlag'):raise HTTPException(400,'Moving-target products are not placed on the fixed sky atlas.')
    def work(job):
        if request.quality==1024:
            content,meta=from_archive(observation,request.ra,request.dec,request.fov,size=1024,native_limit=1280,reader_factory=lambda uri:RangeFITS(uri,budget=192*1024*1024))
        else:content,meta=from_archive(observation,request.ra,request.dec,request.fov)
        return public(cache.put(ident,content,'application/fits',{'kind':'science-cutout','created_at':now(),**meta}))
    return begin(ident,work,SCIENCE)

@router.post('/view')
def prepare_view(view:ViewRequest):
    require_rendered_views(view.survey)
    params=view.model_dump();ident=view_key(params);item=cache.get(ident)
    if item:return {'id':ident,'state':'complete','result':public(item)}
    if CACHED_ONLY:raise HTTPException(409,'This rendered view is not cached.')
    return begin(ident,lambda job:survey_view(params),DOWNLOADS)

@router.get('/jobs/{ident}')
def job(ident:str):
    if ident not in JOBS:raise HTTPException(404,'Job not found. The server may have restarted.')
    return dict(JOBS[ident])

@router.post('/jobs/{ident}/cancel')
def cancel(ident:str):
    if ident in JOBS:JOBS[ident]['cancelled']=True
    return {'cancelled':True,'note':'The current bounded transfer may finish; remaining pack views will be skipped.'}

@router.post('/packs/{route_id}')
def download_pack(route_id:str,survey:tour_surveys.TourSurvey='optical'):
    try:route=tour_surveys.clone_route(expeditions.read(route_id),survey)
    except ValueError as error:raise HTTPException(422,str(error)) from error
    if route['kind']!='waypoints' or not route['stops']:raise HTTPException(400,'Choose a waypoint tour with at least one stop. Continuous recordings can use the visited-tile cache.')
    require_rendered_views(survey)
    if CACHED_ONLY:raise HTTPException(409,'Turn off cached-only mode before downloading a tour.')
    # Separate survey selections and preserve every legacy pack and its pinned files.
    ident=cache.key('pack-survey-v2:'+route_id+':'+str(route['revision'])+':'+survey)
    def work(job):
        pack={'id':ident,'route_id':route_id,'revision':route['revision'],'title':route['title'],'survey':survey,'route':route,'state':'downloading','views':[],'errors':[],'created_at':now(),'total':len(route['stops'])}
        cache.save_pack(pack)
        for i,stop in enumerate(route['stops']):
            if job['cancelled']:break
            job['progress']=f'View {i+1} of {len(route["stops"])}';entry={'index':i}
            try:entry['view']=survey_view(stop,ident)
            except Exception as e:pack['errors'].append({'index':i,'error':str(e)})
            pack['views'].append(entry);cache.save_pack(pack)
        pack['state']='cancelled' if job['cancelled'] else 'partial' if pack['errors'] else 'complete'
        pack['finished_at']=now();cache.save_pack(pack);return pack
    return begin(ident,work,DOWNLOADS)

@router.delete('/packs/{ident}')
def remove_pack(ident:str):
    if ident in JOBS and JOBS[ident]['state'] in ('queued','running'):raise HTTPException(409,'Cancel the active download and wait for its current transfer before removing it.')
    cache.remove_pack(ident);return {'removed':True}

def tile_path(path):
    if path in ('properties','Moc.fits','metadata.xml','preview.jpg'):return True
    return bool(re.fullmatch(r'Norder(?:[0-9]|[12][0-9])/(?:Allsky\.(?:jpg|png|fits)|Dir\d{1,18}/Npix\d{1,18}\.(?:jpg|png|fits|webp))',path))

def rewrite_survey_properties(survey_id,raw):
    value=raw.decode('utf-8')
    if survey_id=='cefca-virgo':
        # CEFCA's published 2015 survey uses Aladin's legacy property names.
        # Lite 3.8.2 requires hips_frame/hips_order. Translate this configured
        # survey only, retaining the provider's order, frame and formats.
        properties={k.strip():v.strip() for line in value.splitlines()
                    if '=' in line and not line.lstrip().startswith('#')
                    for k,v in [line.split('=',1)]}
        additions={}
        if not properties.get('hips_frame'):
            if properties.get('coordsys')!='C':raise ValueError('CEFCA survey coordinate frame is unsupported.')
            additions['hips_frame']='equatorial'
        if not properties.get('hips_order'):
            order=properties.get('maxOrder','')
            if not re.fullmatch(r'\d{1,2}',order) or not 0<=int(order)<=29:
                raise ValueError('CEFCA survey tile order is invalid.')
            additions['hips_order']=str(int(order))
        if not properties.get('hips_tile_format'):
            formats=properties.get('format','').lower().split()
            if not formats or any(v not in ('jpeg','png','fits','webp') for v in formats):
                raise ValueError('CEFCA survey tile format is unsupported.')
            additions['hips_tile_format']=' '.join(formats)
        if not properties.get('dataproduct_type'):additions['dataproduct_type']='image'
        if not properties.get('obs_title'):additions['obs_title']='CEFCA Virgo Cluster'
        value+='\n'+'\n'.join(k+' = '+v for k,v in additions.items())
    value=re.sub(r'^hips_service_url(?:_\d+)?\s*=.*$', '',value,flags=re.M)
    return (value+'\nhips_service_url = http://127.0.0.1:8765/api/atlas/surveys/'+survey_id+'\n').encode()


def fetch_tile(survey_id,part,url,ident,refresh=False):
    """Concurrent map/preview requests for one tile share a single transfer."""
    with TILE_LOCK:
        pending=TILE_PENDING.get(ident)
        leader=pending is None
        if leader:pending=Future();TILE_PENDING[ident]=pending
    if not leader:return pending.result(timeout=110)
    try:
        # A completed transfer may have filled the cache after this request's
        # first lookup but before it became the leader.
        with cache.LOCK:
            item=None if refresh else cache.get(ident)
            result=(item['path'].read_bytes(),item['mime'],item['metadata']) if item else None
        if result is None:
            raw,mime,retrieval_url=read_tile_remote(url)
            if part=='properties':
                raw=rewrite_survey_properties(survey_id,raw)
            metadata={'source_url':url,'retrieval_url':retrieval_url,'created_at':now()}
            cache.put(ident,raw,mime,metadata)
            result=(raw,mime,metadata)
        pending.set_result(result)
        return result
    except BaseException as error:
        pending.set_exception(error)
        raise
    finally:
        with TILE_LOCK:TILE_PENDING.pop(ident,None)

def refresh_tile(survey_id,part,url,ident):
    # Bound both concurrency and queued refreshes. A revisit never waits on them.
    with TILE_LOCK:
        if CACHED_ONLY or ident in TILE_REFRESHING or len(TILE_REFRESHING)>=24:return
        TILE_REFRESHING.add(ident)
    def work():
        try:
            if not CACHED_ONLY:fetch_tile(survey_id,part,url,ident,refresh=True)
        except Exception:pass  # Keep the last successful pixels and retrieval date.
        finally:
            with TILE_LOCK:TILE_REFRESHING.discard(ident)
    try:TILE_REFRESH.submit(work)
    except RuntimeError:
        with TILE_LOCK:TILE_REFRESHING.discard(ident)

@router.get('/surveys/{survey_id}/{part:path}')
def survey_tile(survey_id:str,part:str):
    if survey_id not in SURVEYS or not tile_path(part):raise HTTPException(404,'Unknown survey tile.')
    url=SURVEYS[survey_id]['url']+'/'+part;ident=cache.key('tile:'+url);stale=False
    try:
        # Copy bytes under the eviction lock before any background replacement.
        with cache.LOCK:
            item=cache.get(ident)
            data=item['path'].read_bytes() if item else None
        if item:
            mime=item['mime'];metadata=item['metadata']
            age=(datetime.now(timezone.utc)-datetime.fromisoformat(metadata['created_at'])).total_seconds()
            stale=age>86400
            if stale and not CACHED_ONLY:refresh_tile(survey_id,part,url,ident)
        else:data,mime,metadata=fetch_tile(survey_id,part,url,ident)
        # A cached legacy response must also work after this compatibility update.
        if survey_id=='cefca-virgo' and part=='properties':data=rewrite_survey_properties(survey_id,data)
        return Response(data,media_type='text/plain' if part=='properties' else mime,headers={
            'Cache-Control':'public, max-age='+('60' if stale else '86400'),
            'X-Atlas-Retrieved':metadata['created_at'],'X-Atlas-Stale':str(stale).lower(),
            'X-Atlas-Retrieval-URL':metadata.get('retrieval_url',metadata.get('source_url',url)),
            'X-Atlas-Cache':'stale' if stale else 'hit' if item else 'miss'})
    except httpx.HTTPStatusError as e:
        if e.response.status_code==404:raise HTTPException(404,'This survey has no tile at this position and resolution.') from None
        raise HTTPException(503,'The survey server could not return this tile.') from None
    except Exception as e:raise HTTPException(503,str(e))
