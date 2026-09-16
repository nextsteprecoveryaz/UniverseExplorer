"""Universe Explorer: a loopback-only Windows astronomy workbench."""
import asyncio
import io
import json
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import quote, urlparse

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

import integrations as remote
import science
import object_map
import cloud_ai
import recent_archive
import webb_gallery
import photometry
import aladin_desktop
import expeditions
import atlas
import research
import sdss
import narration

ROOT=Path(__file__).parent
DATA=ROOT/'data'
DATA.mkdir(exist_ok=True)
app=FastAPI(title='Universe Explorer',version='0.1.0')
app.include_router(expeditions.router)
app.include_router(atlas.router)
app.include_router(research.router)
app.include_router(sdss.router)
app.include_router(narration.router)
app.add_middleware(TrustedHostMiddleware,allowed_hosts=['127.0.0.1','localhost','testserver'])
HEAVY=asyncio.Semaphore(1)
CLOUD_BUSY=asyncio.Lock()

SURVEYS=[
 {'id':'2mass','name':'2MASS · near-infrared survey','tag':'NEAR-INFRARED','url':'https://alasky.cds.unistra.fr/2MASS/Color','group':'Telescope views','description':'2MASS J/H/K near-infrared color survey from ground-based telescopes. Space Telescope Live uses this survey behind Webb pointings. Continuous sky context; these pixels are not JWST exposures.'},
 {'id':'webb-color','name':'Webb · released color','tag':'COMPOSITE','url':'https://alasky.cds.unistra.fr/JWST-outreach/CDS_P_JWST_EPO','group':'Telescope views','description':'Selected released JWST outreach composites. Assigned colors combine infrared filters. Coverage is limited to published fields; blank areas are unobserved in this layer.'},
 {'id':'hubble-color','name':'Hubble · released color','tag':'COMPOSITE','url':'https://alasky.cds.unistra.fr/HST-outreach/CDS_P_HST_EPO','group':'Telescope views','description':'Selected Hubble outreach composites, projected onto the sky by CDS. Sparse coverage of released images; not a complete or uniformly processed survey.'},
 {'id':'optical','name':'Visible sky · DSS2','tag':'OPTICAL','url':'https://alasky.cds.unistra.fr/DSS/DSSColor','group':'Telescope views','description':'Digitized Sky Survey from ground-based telescopes, color combined by CDS. Wide sky context; not a Hubble or Webb exposure.'},
 {'id':'webb-200','name':'Webb · F200W','tag':'2.0 μm','url':'https://alasky.cds.unistra.fr/JWST/CDS_P_JWST_F200W','group':'Telescope views','description':'JWST F200W near-infrared images (CDS beta mosaic). Broad band includes starlight and other emission; it does not isolate a gas.'},
 {'id':'webb-444','name':'Webb · F444W','tag':'4.4 μm','url':'https://alasky.cds.unistra.fr/JWST/CDS_P_JWST_F444W','group':'Telescope views','description':'JWST F444W infrared images (CDS beta mosaic). Mixed continuum and emission features; not an isolated chemical map.'},
 {'id':'hydrogen','name':'Ionized hydrogen · Hα','tag':'656.3 nm','url':'https://alasky.cds.unistra.fr/FinkbeinerHalpha','group':'Gas & wavelength lenses','description':'Finkbeiner H-alpha composite survey: a real map tracing ionized hydrogen emission. Lower resolution than Hubble/Webb; no depth or abundance measurement is implied.'},
 {'id':'hst-ha','name':'Hubble · Hα filters','tag':'F656N / F657N','url':'https://alasky.cds.unistra.fr/HST-hips/filter_Halpha_hips','group':'Gas & wavelength lenses','description':'Hubble exposures through F656N / F657N narrowband filters. Sparse coverage. These bands include continuum and may include nearby lines; continuum subtraction is needed for quantitative gas measurements.'},
 {'id':'oxygen','name':'Hubble · oxygen [O III] band','tag':'F502N','url':'https://alasky.cds.unistra.fr/HST-hips/filter_OIII_hips','group':'Gas & wavelength lenses','description':'Hubble F502N exposures include the [O III] 500.7 nm line plus continuum. Sparse coverage; a filter view, not a calibrated abundance map.'},
 {'id':'sulfur','name':'Hubble · sulfur [S II] band','tag':'F673N family','url':'https://alasky.cds.unistra.fr/HST-hips/filter_SIII_hips','group':'Gas & wavelength lenses','description':'Hubble F673N, FQ672N and FQ674N exposures include the [S II] lines plus continuum. The CDS registry names this layer SIII; the constituent filters target the [S II] band. Sparse coverage; continuum subtraction is not applied here.'},
 {'id':'nitrogen','name':'Hubble · nitrogen [N II] band','tag':'F658N','url':'https://alasky.cds.unistra.fr/HST-hips/filter_NII_hips','group':'Gas & wavelength lenses','description':'Hubble F658N filter exposures around the [N II] / H-alpha region. Line blending and continuum depend on instrument and source redshift; this view alone does not isolate gas abundance.'},
 {'id':'h2','name':'Webb · molecular H₂ band','tag':'F212N','url':'https://alasky.cds.unistra.fr/JWST/CDS_P_JWST_F212N','group':'Gas & wavelength lenses','description':'JWST F212N includes the 2.12 μm molecular-hydrogen line plus continuum. CDS beta mosaic; sparse coverage. A continuum-subtracted line map is required to isolate H₂ emission.'},
 {'id':'dust','name':'Dust emission · 12 μm','tag':'WISE','url':'https://alasky.cds.unistra.fr/WSSA','group':'Gas & wavelength lenses','description':'WISE WSSA 12 μm diffuse dust map (Meisner & Finkbeiner). Traces dust-related infrared emission, not a single gas species.'},
]
SURVEYS.extend([
 {'id':'cefca-virgo','name':'CEFCA · Virgo Cluster','tag':'JAST80 · T80Cam','url':'https://www.cefca.es/img/aladin/VirgoCluster','group':'CEFCA tours','description':'Virgo Cluster color mosaic observed with JAST80 / T80Cam at the Javalambre Observatory. Coverage is limited to this field. Imagery: CEFCA Foundation. The original CEFCA tour is in Spanish.','source_url':'https://www.cefca.es/divulgacion/tour_cumulo_virgo','credit':'CEFCA Foundation','rendered_views':False,'auto_science':False},
 {'id':'sdss-color','name':'SDSS · galaxy color','tag':'DR9 · OPTICAL','url':'https://alasky.cds.unistra.fr/SDSS/DR9/color','group':'SDSS optical lenses','description':'SDSS DR9 optical imaging, combined from g/r/i bands and projected by CDS. Covers part of the sky. For SkyServer DR20 color cutouts and MaNGA DR17 gas maps, open SDSS galaxies.'},
 *[{'id':'sdss-'+band,'name':'SDSS · '+band+' band','tag':'DR9 · '+band,'url':'https://alasky.cds.unistra.fr/SDSS/DR9/band-'+band,'group':'SDSS optical lenses','description':'SDSS DR9 '+band+' broadband optical imaging through CDS HiPS. Includes continuum and spectral features; this is not an isolated gas-emission map.'} for band in ('g','r','i')],
])
atlas.SURVEYS={s['id']:s for s in SURVEYS}
expeditions.SURVEYS.update(atlas.SURVEYS)
DESTINATIONS=[
 {'name':'Pillars of Creation','type':'STAR-FORMING REGION','ra':274.730583,'dec':-13.844944,'fov':0.073,'survey':'webb-color','description':'Explore a small part of the Eagle Nebula, where dense clouds and young stars shape the landscape.','source_url':'https://esawebb.org/images/weic2216a/'},
 {'name':'Carina · Cosmic Cliffs','type':'STELLAR NURSERY','ra':159.216,'dec':-58.621,'fov':0.15,'survey':'webb-color','description':'The edge of a star-forming region in NGC 3324, revealed in Webb infrared imagery.'},
 {'name':'Orion Nebula','type':'NEARBY NEBULA','ra':83.82208,'dec':-5.39111,'fov':1.2,'survey':'optical','description':'A rich star-forming region. Search the archive here for Hubble and Webb observations.'},
 {'name':'Stephan’s Quintet','type':'GALAXY GROUP','ra':339.01,'dec':33.958,'fov':0.15,'survey':'webb-color','description':'A field of interacting galaxies. Compare filters and follow the structures through infrared light.'},
 {'name':'Andromeda Galaxy','type':'SPIRAL GALAXY','ra':10.68471,'dec':41.26875,'fov':3.0,'survey':'optical','description':'Visit M31 in the visible sky survey and look for public Hubble observations across its disk.'},
 {'name':'TRAPPIST-1','type':'KNOWN PLANETARY SYSTEM','ra':346.622,'dec':-5.041,'fov':0.2,'survey':'optical','description':'A star with known planets. Planets will not resolve in this sky view; use the catalog and transit tools.'},
]

def db():
    c=sqlite3.connect(DATA/'notebook.sqlite3')
    c.row_factory=sqlite3.Row
    c.execute('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, ra REAL, dec REAL, survey TEXT, kind TEXT NOT NULL, provenance TEXT NOT NULL)')
    return c

with db() as c: c.commit()

@app.middleware('http')
async def local_boundary(request:Request, call_next):
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin=request.headers.get('origin')
        if origin and origin not in ('http://127.0.0.1:8765','http://localhost:8765'):
            return JSONResponse({'detail':'Cross-origin writes are not allowed.'},status_code=403)
        if request.headers.get('sec-fetch-site')=='cross-site':
            return JSONResponse({'detail':'Cross-site writes are not allowed.'},status_code=403)
        if int(request.headers.get('content-length') or 0)>102*1024*1024:
            return JSONResponse({'detail':'Upload limit is 100 MB.'},status_code=413)
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='strict-origin-when-cross-origin'
    return response

@app.exception_handler(ValueError)
async def value_error(request,exc):
    return JSONResponse({'detail':str(exc)},status_code=400)

@app.exception_handler(httpx.HTTPError)
async def network_error(request,exc):
    return JSONResponse({'detail':'The archive could not return this resource. It may be unavailable or access restricted. Retry or open its source page.'},status_code=502)

@app.exception_handler(cloud_ai.CloudError)
async def cloud_error(request,exc):
    return JSONResponse({'detail':str(exc)},status_code=exc.status)

@app.get('/api/objects/featured')
def featured_objects():
    return {'rows':object_map.FEATURED}

@app.get('/api/objects')
async def mapped_objects(ra:float=Query(ge=0,lt=360),dec:float=Query(ge=-90,le=90),radius:float=Query(default=.1,ge=.005,le=1)):
    return await object_map.objects(ra,dec,radius)

@app.get('/api/cloud/status')
def cloud_status():
    return cloud_ai.status()

class CloudConnection(BaseModel):
    api_key:SecretStr
    remember:bool=False
    service:Literal['image','speech']='image'

@app.post('/api/cloud/connect')
async def connect_cloud(body:CloudConnection):
    return await cloud_ai.connect(body.api_key.get_secret_value(),body.remember,body.service)

@app.post('/api/cloud/disconnect')
def disconnect_cloud():
    return cloud_ai.disconnect()

class CloudEdit(BaseModel):
    quality:Literal['low','medium','high']='medium'
    instructions:str=Field(default='',max_length=2000)
    stretch:Literal['asinh','linear','log']='asinh'

@app.post('/api/images/{image_id}/enhance-cloud')
async def enhance_cloud(image_id:str,body:CloudEdit):
    if CLOUD_BUSY.locked():raise HTTPException(409,'A cloud edit is already running. Wait for it to finish before starting another.')
    async with CLOUD_BUSY:
        return await cloud_ai.enhance(image_id,body.quality,body.instructions,body.stretch)

@app.get('/api/images/{image_id}/cloud-ai/{variant}')
def cloud_image(image_id:str,variant:str,download:bool=False):
    m=science.metadata(image_id)
    if not re.fullmatch('[0-9a-f]{32}',variant) or not any(v['variant']==variant for v in m.get('cloud_history',[])):
        raise HTTPException(404,'Enhanced image not found.')
    return FileResponse(science.IMAGES/(image_id+'-cloud-'+variant+'.png'),media_type='image/png',filename=(m['name']+'-CLOUD-AI-VISUALIZATION.png') if download else None)

@app.get('/api/images/{image_id}/handoff')
def chatgpt_handoff(image_id:str,stretch:Literal['asinh','linear','log']='asinh'):
    import zipfile
    m,content,size=cloud_ai.prepare(image_id,stretch)
    manifest={'image_id':image_id,'name':m['name'],'input_size':size,'original_sha256':m['sha256'],'scientific_evidence':False,'instructions':cloud_ai.BASE_PROMPT}
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('astronomy-preview.png',content)
        z.writestr('prompt.txt',cloud_ai.BASE_PROMPT)
        z.writestr('provenance.json',json.dumps(manifest,indent=2))
    return Response(out.getvalue(),media_type='application/zip',headers={'Content-Disposition':f'attachment; filename="chatgpt-enhancement-{image_id[:8]}.zip"'})

@app.post('/api/images/{image_id}/import-enhancement')
async def import_enhancement(image_id:str,file:UploadFile=File(...)):
    content=await upload_bytes(file)
    m=science.metadata(image_id)
    async with HEAVY:
        return await run_in_threadpool(cloud_ai.save_result,image_id,content,provider='Imported AI result',model='User supplied; not verified',prompt='Externally enhanced image imported by user; exact external prompt and input are not verified.',input_size=[m['preview_width'],m['preview_height']],input_sha256=None)

@app.get('/api/health')
def health():
    return {'status':'ok','app':'Universe Explorer','version':'0.1.0','local_ai':(ROOT/'models'/'FSRCNN_x2.pb').exists()}

@app.get('/api/config')
def config():
    return {'surveys':SURVEYS,'destinations':DESTINATIONS,'requested_observation':remote.REQUESTED_OBS,'sources':[
      {'name':'NASA Space Telescope Live','url':'https://spacetelescopelive.org'},
      {'name':'MAST public archive','url':'https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html'},
      {'name':'CDS Aladin / HiPS','url':'https://aladin.cds.unistra.fr/AladinLite/'},
      {'name':'SDSS SkyServer DR20','url':'https://skyserver.sdss.org/dr20/VisualTools/navi'},
      {'name':'SDSS-IV MaNGA DR17','url':'https://www.sdss4.org/surveys/manga/'},
      {'name':'NASA Exoplanet Archive','url':'https://exoplanetarchive.ipac.caltech.edu'},
    ]}

@app.get('/api/live')
async def live():
    async def one(telescope):
        try: return await remote.live_observation(telescope)
        except ValueError as e: return {'telescope':telescope,'error':str(e),'source_url':remote.LIVE+'/'+telescope}
    rows=await asyncio.gather(one('webb'),one('hubble'))
    return {'rows':rows,'checked_at':remote.now(),'refresh_seconds':60}

@app.get('/api/live-at/{telescope}')
async def observation_at(telescope:Literal['webb','hubble'],at:str=Query(min_length=10,max_length=50)):
    return await remote.live_at_time(telescope,at)

@app.get('/api/live/{telescope}/{obs_id}')
async def observation(telescope:Literal['webb','hubble'],obs_id:str):
    if not re.fullmatch(r'[A-Z0-9]{26}',obs_id): raise ValueError('Invalid observation identifier.')
    return await remote.live_observation(telescope,obs_id)

@app.get('/api/resolve')
async def resolve(name:str=Query(min_length=1,max_length=150)):
    return await remote.resolve(name)

@app.get('/api/archive')
async def archive(ra:float=Query(ge=0,lt=360),dec:float=Query(ge=-90,le=90),radius:float=Query(default=0.1,ge=0.001,le=1),telescope:Literal['both','webb','hubble']='both',page:int=Query(default=1,ge=1,le=10000),band:Literal['all','ha','oiii','sii','h2','nir','mir']='all'):
    return await remote.archive_search(ra,dec,radius,telescope,page,band)

@app.get('/api/products/{obsid}')
async def products(obsid:str):
    if not obsid.isdigit() or len(obsid)>20: raise ValueError('Invalid MAST product group.')
    return await remote.products(obsid)

@app.get('/api/exoplanets')
async def exoplanets(ra:float=Query(ge=0,lt=360),dec:float=Query(ge=-90,le=90),radius:float=Query(default=5,ge=0.01,le=20)):
    return await remote.exoplanets(ra,dec,radius)

@app.get('/api/catalog-match')
async def catalog_match(ra:float=Query(ge=0,lt=360),dec:float=Query(ge=-90,le=90)):
    return await remote.catalog_match(ra,dec)

@app.get('/api/archive-preview')
async def archive_preview(uri:str=Query(max_length=1500)):
    if uri.startswith('mast:'):
        data=await remote.download_mast(uri,max_bytes=15*1024*1024)
    else:
        u=urlparse(uri)
        if u.scheme!='https' or u.hostname not in ['mast.stsci.edu','archive.stsci.edu','hla.stsci.edu']:
            raise ValueError('Preview must come from the MAST archive.')
        async with httpx.AsyncClient(timeout=40,follow_redirects=True) as c:
            async with c.stream('GET',uri) as r:
                r.raise_for_status(); buf=bytearray()
                async for chunk in r.aiter_bytes():
                    buf.extend(chunk)
                    if len(buf)>15*1024*1024: raise ValueError('Preview exceeds 15 MB.')
                data=bytes(buf)
    from PIL import Image, JpegImagePlugin, UnidentifiedImageError
    try:
        # Apply explicit limits to JPEG headers before using decoder reduction.
        # Other formats retain Pillow's normal decompression safeguards.
        jpeg=data.startswith(b'\xff\xd8\xff')
        with (JpegImagePlugin.JpegImageFile(io.BytesIO(data)) if jpeg else Image.open(io.BytesIO(data))) as im:
            # JPEG decoder reduction handles large MAST mosaics without first
            # allocating the complete pixel array. Original products are untouched.
            if jpeg:
                if im.width*im.height>160_000_000:raise HTTPException(413,'This archive preview is too large. Open its science products instead.')
                im.draft('RGB',(1200,1200))
            if im.width*im.height>25_000_000:
                raise HTTPException(413,'This archive preview is too large. Open its science products instead.')
            im.thumbnail((1200,1200)); out=io.BytesIO(); im.convert('RGB').save(out,format='JPEG')
    except Image.DecompressionBombError:
        raise HTTPException(413,'This archive preview is too large. Open its science products instead.')
    except (UnidentifiedImageError,OSError):
        raise HTTPException(422,'This archive preview could not be decoded. Open its science products instead.')
    return Response(out.getvalue(),media_type='image/jpeg',headers={'Cache-Control':'private, max-age=3600'})

async def upload_bytes(file):
    data=await file.read(100*1024*1024+1)
    if len(data)>100*1024*1024: raise ValueError('Upload limit is 100 MB.')
    return data

@app.post('/api/images/upload')
async def upload(file:UploadFile=File(...),context:str=Form(default='')):
    content=await upload_bytes(file)
    info={}
    if context:
        info=json.loads(context)
        if not isinstance(info,dict): raise ValueError('Invalid image context.')
    async with HEAVY:
        return await run_in_threadpool(science.import_image,content,file.filename or 'image','Sky view capture' if info else 'Local upload',info)

class ImportProduct(BaseModel):
    uri:str=Field(max_length=1000)
    filename:str=Field(max_length=250)
    observation:dict=Field(default_factory=dict)

@app.post('/api/images/import')
async def import_product(body:ImportProduct):
    async with HEAVY:
        content=await remote.download_mast(body.uri)
        return await run_in_threadpool(science.import_image,content,body.filename,body.uri,body.observation)

@app.get('/api/images/{image_id}')
def image_meta(image_id:str): return science.metadata(image_id)

@app.get('/api/images')
def image_library():
    paths=sorted([p for p in science.IMAGES.glob('*.json') if re.fullmatch(r'[0-9a-f]{32}',p.stem)],key=lambda p:p.stat().st_mtime,reverse=True)
    rows=[]
    for p in paths[:100]:
        try: rows.append(json.loads(p.read_text(encoding='utf-8')))
        except (ValueError,OSError): continue
    return {'rows':rows,'limit':100}

@app.get('/api/images/{image_id}/preview')
def preview(image_id:str,stretch:Literal['asinh','linear','log']='asinh'):
    return FileResponse(science.render(image_id,stretch),media_type='image/png')

@app.get('/api/images/{image_id}/original')
def original(image_id:str):
    m=science.metadata(image_id)
    return FileResponse(science.IMAGES/m.get('original_file',image_id+m['extension']),filename=m['name'])

@app.get('/api/images/{image_id}/ai')
def ai_image(image_id:str,download:bool=False):
    m=science.metadata(image_id)
    if not m.get('ai'): raise HTTPException(404,'No enhanced image exists yet.')
    return FileResponse(science.IMAGES/(image_id+'-ai.png'),media_type='image/png',filename=(m['name']+'-AI-VISUALIZATION.png') if download else None)

@app.post('/api/images/{image_id}/enhance')
async def enhance(image_id:str):
    async with HEAVY: return await run_in_threadpool(science.enhance,image_id)

@app.post('/api/images/{image_id}/detect')
async def detect(image_id:str,sigma:float=Query(default=6,ge=3,le=20)):
    async with HEAVY: return await run_in_threadpool(science.detect_sources,image_id,sigma)

@app.post('/api/transits')
async def transits(file:UploadFile=File(...),min_period:float=Form(default=0.5,ge=0.1,le=100),max_period:float=Form(default=15,ge=0.2,le=365)):
    if max_period<=min_period: raise ValueError('Maximum period must exceed minimum period.')
    content=await upload_bytes(file)
    async with HEAVY:
        return await run_in_threadpool(science.transit_search,content,file.filename or 'lightcurve.csv',min_period,max_period)

class Note(BaseModel):
    title:str=Field(min_length=1,max_length=200)
    body:str=Field(default='',max_length=20000)
    ra:float|None=Field(default=None,ge=0,lt=360)
    dec:float|None=Field(default=None,ge=-90,le=90)
    survey:str=Field(default='',max_length=150)
    kind:Literal['field','source candidate','transit candidate']='field'
    provenance:dict=Field(default_factory=dict)

@app.get('/api/notes')
def notes():
    with db() as c:
        rows=[dict(r) for r in c.execute('SELECT * FROM notes ORDER BY created_at DESC')]
    for r in rows: r['provenance']=json.loads(r['provenance'])
    return {'rows':rows}

@app.post('/api/notes')
def add_note(note:Note):
    n={**note.model_dump(),'id':uuid.uuid4().hex,'created_at':remote.now()}
    with db() as c:
        c.execute('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?)',(n['id'],n['created_at'],n['title'],n['body'],n['ra'],n['dec'],n['survey'],n['kind'],json.dumps(n['provenance'])))
        c.commit()
    return n

@app.delete('/api/notes/{note_id}')
def delete_note(note_id:str):
    with db() as c:
        cursor=c.execute('DELETE FROM notes WHERE id=?',(note_id,)); c.commit()
    if not cursor.rowcount: raise HTTPException(404,'Note not found.')
    return {'deleted':True}

@app.get('/api/recent/status')
def recent_status(): return recent_archive.status()

@app.get('/api/photometry')
async def sed_photometry(target:str=Query(...,min_length=1,max_length=200),radius:float=Query(5,ge=.1,le=30),refresh:bool=False):
    return await photometry.query(target,radius,refresh)

@app.get('/api/photometry/files/{key}.vot')
def sed_file(key:str): return FileResponse(photometry.votable(key),media_type='application/x-votable+xml',filename='vizier-photometry.vot')

@app.get('/api/aladin/status')
def desktop_status(): return aladin_desktop.status()

@app.post('/api/aladin/open')
def desktop_open(): return aladin_desktop.launch()

class AladinPoint(BaseModel):
    ra:float=Field(ge=0,lt=360)
    dec:float=Field(ge=-90,le=90)

@app.post('/api/aladin/point')
def desktop_point(point:AladinPoint): return aladin_desktop.point(point.ra,point.dec)

@app.post('/api/aladin/photometry/{key}')
def desktop_photometry(key:str): return aladin_desktop.send_file(photometry.votable(key),'table.load.votable','VizieR photometry')

@app.post('/api/aladin/image/{image_id}')
def desktop_image(image_id:str):
    m=science.metadata(image_id)
    path=science.IMAGES/m.get('original_file',image_id+m['extension'])
    return aladin_desktop.send_file(path,'image.load.fits' if m['scientific'] else 'image','Universe Explorer original: '+m['name'])

@app.get('/api/gallery/status')
def gallery_status(): return webb_gallery.status()

@app.post('/api/gallery/update')
async def gallery_update(): return webb_gallery.start_sync()

@app.get('/api/gallery/photos')
def gallery_list(source:str=Query('all',max_length=30),page:int=Query(1,ge=1),search:str=Query('',max_length=150),mapped:bool=False):
    return webb_gallery.listing(source,page,search,mapped)

@app.get('/api/gallery/map')
def gallery_map(): return webb_gallery.map_points()

@app.get('/api/gallery/photos/{photo_id}')
def gallery_photo(photo_id:str): return webb_gallery.photo(photo_id)

@app.post('/api/gallery/photos/{photo_id}/import')
async def gallery_import(photo_id:str):
    async with HEAVY:
        content,p=await webb_gallery.image_bytes(photo_id)
        return await run_in_threadpool(science.import_image,content,'NASA Webb '+p['id']+'.jpg',p['source_url'],{'title':p['title'],'ra':p['ra'],'dec':p['dec'],'location':p['location'],'image_url':p['image_url'],'license':p['license'],'description':p['description'],'kind':p['kind']})

@app.post('/api/recent/update')
async def recent_update(): return recent_archive.start_sync()

@app.get('/api/recent/map')
def recent_map(ra:float=Query(0,ge=0,lt=360),dec:float=Query(0,ge=-90,le=90),radius:float=Query(180,gt=0,le=180),fov:float=Query(360,gt=0,le=360),mission:Literal['both','webb','hubble']='both'):
    return recent_archive.map_points(ra,dec,radius,fov,mission)

@app.get('/api/recent/observations')
def recent_list(ra:float|None=Query(None,ge=0,lt=360),dec:float|None=Query(None,ge=-90,le=90),radius:float=Query(180,gt=0,le=180),mission:Literal['both','webb','hubble']='both',page:int=Query(1,ge=1),search:str=Query('',max_length=150)):
    return recent_archive.listing(ra,dec,radius,mission,page,search)

@app.get('/api/recent/observations/{obsid}')
def recent_observation(obsid:str): return recent_archive.observation(obsid)

@app.get('/favicon.ico',include_in_schema=False)
def favicon(): return Response(status_code=204)

app.mount('/',StaticFiles(directory=ROOT/'static',html=True),name='ui')
