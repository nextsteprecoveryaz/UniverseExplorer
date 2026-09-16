"""Local, revisioned flight routes and guided tours with source-backed stops."""
import json
import math
import sqlite3
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator

import coverage_guide as coverage
import cefca_tours
import recent_archive as archive
import webb_gallery as gallery
import object_map
from integrations import now

PATH=Path(__file__).parent/'data'/'flight-routes.sqlite3'
router=APIRouter(prefix='/api/navigation')
SURVEYS={'optical','webb-color','hubble-color','webb-200','webb-444','hydrogen','hst-ha','oxygen','sulfur','nitrogen','h2','dust','cefca-virgo'}

class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)

class View(Strict):
    ra:float=Field(ge=0,lt=360)
    dec:float=Field(ge=-90,le=90)
    fov:float=Field(default=.2,ge=.001,le=360)
    roll:float=Field(default=0,ge=-360,le=360)
    survey:str='optical'
    projection:Literal['AIT','TAN','SIN']='AIT'
    @model_validator(mode='after')
    def valid_survey(self):
        if self.survey not in SURVEYS:raise ValueError('Unknown survey identifier.')
        return self

class Reference(Strict):
    kind:Literal['featured','gallery','mast','cefca']
    id:str=Field(min_length=1,max_length=80,pattern=r'^[A-Za-z0-9_-]+$')

class Stop(View):
    title:str=Field(default='Sky waypoint',min_length=1,max_length=200)
    notes:str=Field(default='',max_length=4000)
    travel:float=Field(default=4,ge=1,le=30)
    hold:float=Field(default=15,ge=3,le=120)
    source:Reference|None=None

class Sample(View):
    t:float=Field(ge=0,le=1800)

class Route(Strict):
    title:str=Field(min_length=1,max_length=200)
    description:str=Field(default='',max_length=4000)
    kind:Literal['waypoints','recording']='waypoints'
    stops:list[Stop]=Field(default_factory=list,max_length=100)
    track:list[Sample]=Field(default_factory=list,max_length=3600)
    @model_validator(mode='after')
    def valid_track(self):
        if self.kind=='waypoints' and self.track:raise ValueError('Waypoint routes cannot contain recorded samples.')
        if self.kind=='recording' and self.stops:raise ValueError('Recordings cannot contain waypoint stops.')
        if self.track and self.track[0].t!=0:raise ValueError('A recording must start at time zero.')
        if any(b.t<=a.t for a,b in zip(self.track,self.track[1:])):raise ValueError('Recording times must increase strictly.')
        return self

class Update(Route):
    revision:int=Field(ge=1)

class Progress(Strict):
    revision:int=Field(ge=1)
    elapsed:float=Field(ge=0,le=20000)
    origin:View

class Import(Strict):
    schema_name:Literal['universe-explorer-route']=Field(alias='schema')
    version:Literal[1]
    route:Route

def connect():
    c=sqlite3.connect(PATH,timeout=20);c.row_factory=sqlite3.Row;c.execute('PRAGMA journal_mode=WAL')
    c.executescript('''CREATE TABLE IF NOT EXISTS routes(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS progress(route_id TEXT PRIMARY KEY,payload TEXT NOT NULL);''')
    return c

def document(row,hydrate=False):
    d={**json.loads(row['payload']),**{k:row[k] for k in ('id','revision','created_at','updated_at')}}
    if hydrate:
        d['media']=[resolve_source(s.get('source')) for s in d['stops']]
        with connect() as c:p=c.execute('SELECT payload FROM progress WHERE route_id=?',(d['id'],)).fetchone()
        d['progress']=json.loads(p[0]) if p else None
        if d['progress'] and d['progress']['revision']!=d['revision']:d['progress']=None
    return d

def resolve_source(ref):
    if not ref:return None
    try:
        if ref['kind']=='featured':
            obj=next(o for o in object_map.FEATURED if o['id']==ref['id'])
            return {**obj,'title':obj['name'],'description':obj['summary'],'kind':'featured','preview_url':None,'available':True,'location_note':'Curated catalog target and published guide. The selected sky survey is credited on the map.'}
        if ref['kind']=='mast':return coverage.observation_media(archive.observation(ref['id']))
        if ref['kind']=='cefca':return cefca_tours.source(ref['id'])
        return coverage.gallery_media(gallery.photo(ref['id']))
    except (ValueError,StopIteration,KeyError):return {'kind':ref['kind'],'id':ref['id'],'available':False,'description':'This source is no longer in the local index. Saved waypoint coordinates remain available.'}

def create(route):
    stamp=now();ident=uuid.uuid4().hex;payload=route.model_dump()
    with connect() as c:c.execute('INSERT INTO routes VALUES(?,?,?,?,?)',(ident,1,stamp,stamp,json.dumps(payload,allow_nan=False)))
    return read(ident)

def read(ident):
    with connect() as c:r=c.execute('SELECT * FROM routes WHERE id=?',(ident,)).fetchone()
    if not r:raise HTTPException(404,'Saved route not found.')
    return document(r,True)

def stop_for(media):
    return Stop(title=media.get('title') or media['name'],ra=media['ra'],dec=media['dec'],fov=media.get('fov',.18),survey=media.get('survey','optical'),source=Reference(kind=media['kind'],id=media['id']))

def templates():
    guides=[{**o,'kind':'featured'} for o in object_map.FEATURED]
    def preset(ident,title,description,items):
        return {'id':ident,**Route(title=title,description=description,stops=[stop_for(m) for m in items]).model_dump(),
                'media':[resolve_source({'kind':m['kind'],'id':m['id']}) for m in items]}
    result=[preset('grand-tour','Landmarks in the light','A guided journey from stellar nurseries to neighboring galaxies, with published explanations and optional source videos.',guides[:5]),
            preset('star-forming','Where stars take shape','Explore the Pillars, Cosmic Cliffs and Orion. Every guide identifies the survey and the source of its explanation.',guides[:3])]
    with gallery.connect() as c:
        rows=c.execute('SELECT payload FROM photos WHERE ra IS NOT NULL ORDER BY posted DESC').fetchall()
    photos=[json.loads(r[0]) for r in rows]
    for ident,title,description,pattern in [
        ('webb-galaxies','Webb: islands of stars','Recent published galaxy images, shown beside their catalog target positions.',r'galax|quintet|arp '),
        ('webb-nebulae','Webb: clouds and new stars','Published nebula and star-forming-region images. JPEG target markers are not calibrated image footprints.',r'nebula|star.form|pillar|cliff|orion|tarantula'),
        ('webb-releases','The latest located Webb releases','The newest published images for which the local gallery has resolved an astronomical target.',None)]:
        import re
        chosen=[]
        for p in photos:
            if p.get('kind')!='Published image':continue
            if pattern and not re.search(pattern,p['title']+' '+p.get('description','')[:500],re.I):continue
            if any(coverage.separation(p['ra'],p['dec'],q['ra'],q['dec'])<.035 for q in chosen):continue
            chosen.append(p)
            if len(chosen)>=8:break
        if chosen:result.append(preset(ident,title,description,[coverage.gallery_media(p) for p in chosen]))
    with archive.connect() as c:
        generation=archive.active(c)
        for mission,label in [('HST','Hubble'),('JWST','Webb')]:
            recent=c.execute('SELECT payload FROM observations WHERE generation=? AND mission=? AND ra IS NOT NULL AND dec IS NOT NULL ORDER BY observed DESC LIMIT 1500',(generation,mission)).fetchall()
            chosen=[]
            for row in recent:
                o=json.loads(row[0])
                if o.get('mtFlag') or not o.get('jpegURL'):continue
                if any(coverage.separation(o['s_ra'],o['s_dec'],m['ra'],m['dec'])<.035 for m in chosen):continue
                chosen.append(coverage.observation_media(o))
                if len(chosen)>=6:break
            if chosen:result.append(preset('recent-'+mission.lower(),'Recent public '+label+' fields','Six distinct fields selected from the latest 1,500 observation records in this local telescope index. Actual MAST previews, instrument filters and exposure dates accompany the sky context.',chosen))
    cefca=cefca_tours.template_metadata()
    result.append({**preset(cefca['id'],cefca['title'],cefca['description'],cefca_tours.media_items()),**cefca})
    return result

@router.get('/templates')
def get_templates():return {'rows':templates()}

@router.get('/nearby')
def get_nearby(ra:float=Query(...,ge=0,lt=360),dec:float=Query(...,ge=-90,le=90),radius:float=Query(10,ge=.01,le=180),mission:Literal['both','webb','hubble']='both',limit:int=Query(8,ge=1,le=12)):
    return coverage.nearby(ra,dec,mission,radius,limit)

@router.get('/routes')
def list_routes():
    with connect() as c:rows=c.execute('SELECT * FROM routes ORDER BY updated_at DESC').fetchall()
    result=[]
    for row in rows:
        d=document(row);d['stop_count']=len(d.pop('stops'));track=d.pop('track');d['sample_count']=len(track)
        d['duration']=track[-1]['t'] if track else sum(s['travel']+s['hold'] for s in json.loads(row['payload'])['stops'])
        result.append(d)
    return {'rows':result}

@router.post('/routes')
def add_route(route:Route):return create(route)

@router.post('/import')
def import_route(bundle:Import):return create(bundle.route)

@router.get('/routes/{ident}')
def get_route(ident:str):return read(ident)

@router.put('/routes/{ident}')
def update_route(ident:str,route:Update):
    payload=route.model_dump(exclude={'revision'})
    with connect() as c:
        changed=c.execute('UPDATE routes SET revision=revision+1,updated_at=?,payload=? WHERE id=? AND revision=?',(now(),json.dumps(payload,allow_nan=False),ident,route.revision)).rowcount
        if not changed:
            if not c.execute('SELECT 1 FROM routes WHERE id=?',(ident,)).fetchone():raise HTTPException(404,'Saved route not found.')
            raise HTTPException(409,'This route was changed in another window. Reload it before saving; your unsaved changes have not overwritten it.')
    return read(ident)

@router.delete('/routes/{ident}')
def delete_route(ident:str,revision:int=Query(...,ge=1)):
    with connect() as c:
        changed=c.execute('DELETE FROM routes WHERE id=? AND revision=?',(ident,revision)).rowcount
        if not changed:raise HTTPException(409,'Route changed or was already removed. Refresh the route list.')
        c.execute('DELETE FROM progress WHERE route_id=?',(ident,))
    return {'deleted':True}

@router.put('/routes/{ident}/progress')
def save_progress(ident:str,progress:Progress):
    with connect() as c:
        row=c.execute('SELECT revision FROM routes WHERE id=?',(ident,)).fetchone()
        if not row or row[0]!=progress.revision:raise HTTPException(409,'Route changed; playback progress was not applied.')
        c.execute('INSERT OR REPLACE INTO progress VALUES (?,?)',(ident,json.dumps(progress.model_dump())))
    return {'saved':True}

@router.get('/routes/{ident}/export')
def export_route(ident:str):
    r=read(ident)
    return {'schema':'universe-explorer-route','version':1,'route':{k:r[k] for k in Route.model_fields}}
