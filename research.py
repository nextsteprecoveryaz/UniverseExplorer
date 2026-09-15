"""Research desk routes. Long tasks share the bounded atlas job queue."""
import asyncio,json,uuid
from typing import Annotated
from fastapi import APIRouter,Query
from pydantic import BaseModel,ConfigDict,Field,model_validator
from starlette.concurrency import run_in_threadpool
import atlas
import field_history as history
import epoch_images
import discovery
import research_services as services

router=APIRouter(prefix='/api/research')
Record=Annotated[str,Field(pattern=r'^\d{1,20}$')]
ImageId=Annotated[str,Field(pattern=r'^[a-f0-9]{32}$')]

class Position(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    ra:float=Field(ge=0,lt=360)
    dec:float=Field(ge=-90,le=90)

class Cone(Position):radius:float=Field(default=.025,ge=.0001,le=.5)
class Watch(Cone):title:str=Field(min_length=1,max_length=180)
class Guide(Cone):question:str=Field(default='What am I looking at?',max_length=1000)
class ImageField(Position):
    fov:float=Field(ge=.0001,le=.5)
    ids:list[Record]=Field(min_length=1,max_length=4)
class EpochPair(ImageField):
    ids:list[Record]=Field(min_length=2,max_length=2)
    psf:list[Annotated[float,Field(ge=.005,le=3)]]|None=Field(default=None,min_length=2,max_length=2)
class Evidence(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    image_id:ImageId
    threshold:float=Field(default=6,ge=3,le=20)
    fwhm:float=Field(default=2.5,ge=1,le=6)
class Repeat(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    first:ImageId
    second:ImageId
    radius:float=Field(default=1,ge=.01,le=10)
class Tess(Position):radius:float=Field(default=10,ge=1,le=60)
class Transit(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    min_period:float=Field(default=.5,ge=.1,le=100)
    max_period:float=Field(default=15,ge=.2,le=365)
    @model_validator(mode='after')
    def period_order(self):
        if self.min_period>=self.max_period:raise ValueError('Maximum period must exceed minimum period.')
        return self

def job(work,science=False):
    return atlas.begin('research-'+uuid.uuid4().hex,work,atlas.SCIENCE if science else atlas.DOWNLOADS)
def online():
    if atlas.CACHED_ONLY:raise ValueError('Turn off Cached-only atlas before retrieving new research data.')

@router.post('/history')
def fetch_history(body:Cone):
    online();return job(lambda j:asyncio.run(history.fetch(**body.model_dump(),job=j)))
@router.get('/history')
def saved_history():return {'rows':history.saved()}
@router.get('/history/{ident}')
def get_history(ident:ImageId):return history.result(ident)
@router.get('/observations/{ident}')
def get_observation(ident:Record):return history.observation(ident)
@router.post('/compare')
def compare(body:EpochPair):
    online();return job(lambda j:epoch_images.compare(**body.model_dump(),job=j),True)
@router.post('/mosaic')
def mosaic(body:ImageField):
    online();return job(lambda j:epoch_images.mosaic(**body.model_dump(),job=j),True)
@router.post('/evidence')
def evidence(body:Evidence):return job(lambda j:discovery.analyze(**body.model_dump()),True)
@router.get('/evidence/{image_id}')
def evidence_report(image_id:ImageId):
    discovery.science.metadata(image_id)
    path=discovery.science.IMAGES/(image_id+'-evidence.json')
    if not path.exists():raise ValueError('This original has not been analyzed in the research desk.')
    return json.loads(path.read_text())
@router.post('/repeat')
def repeat(body:Repeat):return discovery.repeat_check(**body.model_dump())
@router.post('/catalogs')
async def catalogs(body:Position):return await services.catalogs(**body.model_dump())
@router.get('/stars')
async def stars(radius:float=Query(default=25,ge=5,le=100)):return await services.neighborhood(radius)
@router.post('/tess')
def tess(body:Tess):
    online();return job(lambda j:asyncio.run(services.tess_search(**body.model_dump())))
@router.post('/tess/{ident}/analyze')
def tess_analysis(ident:Record,body:Transit):
    online();return job(lambda j:asyncio.run(services.tess_analyze(ident,**body.model_dump())),True)
@router.get('/watches')
def watches():return services.watches()
@router.post('/watches')
def add_watch(body:Watch):return services.add_watch(body.model_dump())
@router.post('/watches/check')
def check_watches():return services.check_watches()
@router.delete('/watches/{ident}')
def remove_watch(ident:ImageId):services.remove_watch(ident);return {'removed':True}
@router.post('/notices/{ident}/read')
def read_notice(ident:ImageId):services.read_notice(ident);return {'read':True}
@router.post('/guide')
async def guide(body:Guide):return await services.guide(**body.model_dump())
