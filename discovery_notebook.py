"""Persistent, source-backed notebook research and portable tour stories."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import math
from pathlib import Path
import re
import sqlite3
import threading
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal
import integrations as remote
import object_map
import object_facts
import science

PATH=Path(__file__).parent/'data'/'notebook.sqlite3'
router=APIRouter(prefix='/api/notebook')
POOL=ThreadPoolExecutor(max_workers=2,thread_name_prefix='notebook-research')
LOCK=threading.RLock()
PENDING={}
BUSY={'queued','researching'}


def connect():
    with LOCK:
        c=sqlite3.connect(PATH,timeout=20);c.row_factory=sqlite3.Row
        c.execute('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, ra REAL, dec REAL, survey TEXT, kind TEXT NOT NULL, provenance TEXT NOT NULL)')
        columns={r[1] for r in c.execute('PRAGMA table_info(notes)')}
        if 'research' not in columns and c.execute('SELECT COUNT(*) FROM notes').fetchone()[0]:
            backup=PATH.with_name(PATH.stem+'-before-stories-'+uuid.uuid4().hex[:8]+'.sqlite3')
            with sqlite3.connect(backup) as destination:c.backup(destination)
        for name,definition in [('research',"TEXT NOT NULL DEFAULT '{}'"),('revision','INTEGER NOT NULL DEFAULT 1')]:
            if name not in columns:c.execute(f'ALTER TABLE notes ADD COLUMN {name} {definition}')
        c.commit();return c


def unpack(row):
    n=dict(row);n['provenance']=json.loads(n['provenance']);n['research']=json.loads(n['research'])
    if n['research'].get('status') in BUSY and n['id'] not in PENDING:
        n['research']={**n['research'],'status':'interrupted','message':'Research stopped when the app restarted. Choose Research again.'}
    return n


def read(ident):
    with connect() as c:row=c.execute('SELECT * FROM notes WHERE id=?',(ident,)).fetchone()
    if not row:raise HTTPException(404,'Notebook entry not found.')
    return unpack(row)


def all_notes():
    with connect() as c:return [unpack(r) for r in c.execute('SELECT * FROM notes ORDER BY created_at DESC')]


def write_research(ident,research,revision=None):
    query='UPDATE notes SET research=?,revision=revision+1 WHERE id=?';args=[json.dumps(research,allow_nan=False),ident]
    if revision is not None:query+=' AND revision=?';args.append(revision)
    with connect() as c:
        if not c.execute(query,args).rowcount:raise HTTPException(409,'This notebook entry changed. Reload it before saving.')
    return read(ident)


def radius_for(note):
    value=note['provenance'].get('search_radius_arcsec',15)
    try:value=float(value)
    except (TypeError,ValueError):value=15
    return min(180,max(3,value if math.isfinite(value) else 15))/3600


def field_query(note):
    p=note.get('provenance',{});v=p.get('view',p)
    fov=remote.number(v.get('fov'));ra=remote.number(v.get('ra'));dec=remote.number(v.get('dec'))
    if ra is None or dec is None or not 0<=ra<360 or abs(dec)>90:ra,dec=note['ra'],note['dec']
    # Match the object-label layer's bounded field query, even when it is hidden.
    radius=min(1,max(.005,fov*.7)) if fov and 0<fov<=5 else max(radius_for(note),.005)
    if object_map.separation(ra,dec,note['ra'],note['dec'])>radius:ra,dec=note['ra'],note['dec']
    return ra,dec,radius


def candidates_for(note,result,field=False):
    rows=[]
    center_ra,center_dec,radius=field_query(note) if field else (note['ra'],note['dec'],radius_for(note))
    for obj in result.get('rows',[]):
        try:distance=object_map.separation(note['ra'],note['dec'],float(obj['ra']),float(obj['dec']))*3600
        except (TypeError,ValueError,KeyError):continue
        if not math.isfinite(distance) or object_map.separation(center_ra,center_dec,obj['ra'],obj['dec'])>radius+.1/3600:continue
        rows.append({**obj,'separation_arcsec':round(distance,3),'match_scope':'point' if distance<=radius_for(note)*3600+.1 else 'field'})
    rows.sort(key=lambda o:(o['separation_arcsec'],not o.get('featured')))
    return rows[:120]


def selected_object(research,selected=None):
    candidates=research.get('candidates',[])
    return (next((o for o in candidates if o['id']==selected),None)
            or next((o for o in candidates if o.get('featured') and o['separation_arcsec']<=3),None)
            or next(iter(candidates),None))


async def enrich(research,obj):
    if not obj or obj.get('featured'):return research
    details=dict(research.get('object_details',{}))
    try:
        detail=await asyncio.wait_for(object_facts.lookup(obj['name']),timeout=25)
        if detail and object_map.separation(obj['ra'],obj['dec'],detail['ra'],detail['dec'])*3600<=3:
            details[obj['id']]=detail
            candidates=[{**o,'type':detail['type'],'type_code':detail['type_code']} if o['id']==obj['id'] else o for o in research.get('candidates',[])]
            return {**research,'candidates':candidates,'object_details':details,'detail_warning':('Using cached object measurements; their live refresh was unavailable.' if detail.get('stale') else None)}
    except (ValueError,KeyError,TypeError,TimeoutError):pass
    return {**research,'object_details':details,'detail_warning':'Detailed measurements could not be refreshed. Available catalog information and previous measurements are preserved.'}


def background(obj):
    """General educational context, explicitly separate from target measurements."""
    code=obj.get('type_code','');kind=obj.get('type','').lower()
    if code in ('G','GiG','GPair','QSO') or 'galax' in kind:
        return ('A galaxy is a gravitationally bound system of stars, gas, dust and dark matter. Comparing visible and infrared light can reveal different stellar populations and the effects of dust. Galaxies also change through encounters and mergers; a single image is only one moment in that much longer history.',
                {'title':'NASA · Galaxies (general background)','url':'https://science.nasa.gov/universe/galaxies/'})
    if '*' in code or any(t in kind for t in ('star','stellar','nebula','nursery','dwarf')) or code in ('HII','PN','SNR'):
        return ('Stars form when dense regions within clouds of gas and dust collapse under gravity. Their masses shape their lifetimes and how they return material to space. Looking at the same region at different wavelengths helps astronomers study the stars and the material around them. These are general ideas to explore here, not measurements extracted from this snapshot.',
                {'title':'NASA · Stars (general background)','url':'https://science.nasa.gov/universe/stars/'})
    return ('A catalog classification tells us how astronomers currently describe a source. Its references and measurements are the starting point for learning more. Comparing surveys is useful, but brightness and color in a rendered map alone do not establish distance, composition or whether a source is new.',
            {'title':'CDS · SIMBAD object classifications','url':'https://simbad.cds.unistra.fr/Pages/guide/otypes.htx'})


def compose(note,research,selected=None):
    candidates=research.get('candidates',[])
    obj=selected_object(research,selected)
    sources=[]
    if obj:
        label=f"{obj['name']} · {obj['separation_arcsec']:.1f} arcsec from saved point"
        opening=f"This stop explores the field near {obj['name']}. "
        if obj.get('featured'):
            opening+=obj['summary'].replace('The accompanying journey interprets telescope data as a three-dimensional visualization.','The linked publisher video includes a three-dimensional interpretation of telescope data.')
        else:
            opening+=f"SIMBAD classifies this nearby catalog entry as {obj['type'].lower()} (code {obj.get('type_code','not reported')})."
        context,source=background(obj);sources=[{'title':obj['name']+' · '+obj['catalog'],'url':obj['source_url']},source]
        story=opening+'\n\n'+context+'\n\nPause here and compare the visible and near-infrared surveys. Notice what remains visible and what changes with wavelength. The catalog match is a positional association; it does not establish that every visible feature belongs to the same object.'
        detail=research.get('object_details',{}).get(obj['id'])
        if detail:
            facts,sources=object_facts.prose(detail)
            story='This stop explores the field near '+detail['name']+'.\n\n'+facts+'\n\n'+context+'\n\nCompare the saved image with other wavelengths. A catalog association does not establish that every feature in the image belongs to this object.'
            sources.append(source)
        # Reuse the app's checked, object-specific Virgo stories only for a very close catalog match.
        import cefca_tours
        known=next((m for m in cefca_tours.media_items() if object_map.separation(obj['ra'],obj['dec'],m['ra'],m['dec'])*3600<3),None)
        if known and obj['separation_arcsec']<=3:
            story='This stop explores the field near '+known['title']+'.\n\n'+known['narration']
            sources=[sources[0],*known.get('story_sources',[])]
        status='ready' if research.get('catalog_available') else 'partial'
        message='Nearby catalog match; review the position and sources.'
        if len(candidates)>1 and candidates[1]['separation_arcsec']<max(3,obj['separation_arcsec']*2):message='Several catalog entries are close to this point. '+('Using the published guide for the nearby extended target; review the matches below.' if obj.get('featured') else 'Review the match below.')
        if obj.get('match_scope')=='field':
            label=f"{obj['name']} · in the saved field, {obj['separation_arcsec']:.1f} arcsec from saved point"
            message='Using a named object from the wider field. Review the matches to choose the object you intended; the saved point and image are unchanged.'
    else:
        label='Identity unresolved'
        story=(f"This stop preserves a sky field at right ascension {note['ra']:.5f} degrees and declination {note['dec']:.5f} degrees. "
               'No object identity was established by this lookup. That does not mean the field contains a new or uncataloged object.\n\n'
               'Use the saved image as a starting point: compare surveys, zoom in on the feature that caught your attention, and repeat the lookup at its position. '
               'The saved view records a direction on the sky; apparent proximity in the image does not establish physical proximity in space.')
        status='unidentified' if research.get('catalog_available') else 'unavailable'
        message='No catalog entry returned in the point or wider field search.' if research.get('catalog_available') else 'SIMBAD is unavailable. The saved image and location are safe; retry the research later.'
    return {**research,'status':status,'message':message,'selected_id':obj['id'] if obj else None,'identity_label':label,'story':story[:3500],'sources':sources,'checked_at':remote.now(),
            'method':'Named catalog records, referenced measurements and checked summaries, assembled locally. Field associations are distinct from exact point matches. General background is separate from target measurements.','research_version':2,'selection_method':research.get('selection_method','automatic')}


async def investigate(note):
    result,field=await asyncio.wait_for(asyncio.gather(object_map.objects(note['ra'],note['dec'],radius_for(note)),object_map.objects(*field_query(note))),timeout=55)
    old=note.get('research',{})
    rows={o['id']:o for o in candidates_for(note,field,True)+candidates_for(note,result)}
    preferred=old.get('selected_id') if old.get('selection_method')=='manual' or old.get('research_version')!=2 else None
    # An explicitly clicked label is resolved by name, never by the label's screen pixels.
    hint=note.get('provenance',{}).get('object_hint',{})
    if isinstance(hint,dict) and hint.get('name'):
        try:
            named=await asyncio.wait_for(object_facts.lookup(hint['name']),timeout=25)
            matches=candidates_for(note,{'rows':[named]},True) if named else []
            if matches:
                rows[named['id']]=matches[0];preferred=preferred or named['id']
                old={**old,'object_details':{**old.get('object_details',{}),named['id']:named}}
        except (ValueError,KeyError,TypeError,TimeoutError):pass
    candidates=sorted(rows.values(),key=lambda o:(o['id']!=preferred,o['separation_arcsec']))[:120]
    research={**old,'candidates':candidates,'catalog_available':result.get('catalog_available',False) or field.get('catalog_available',False),
              'catalog_stale':result.get('stale',False) or field.get('stale',False),'catalog_fetched_at':field.get('fetched_at') or result.get('fetched_at'),
              'radius_arcsec':radius_for(note)*3600,'field_radius_arcsec':field_query(note)[2]*3600,'field_truncated':field.get('truncated',False)}
    if not candidates and old.get('story') and not research['catalog_available']:raise ValueError('Catalog unavailable; preserving the previous story.')
    first=selected_object(research,preferred)
    if not preferred and first and first.get('match_scope')=='field':
        # A galaxy's disk may contain nearer component/transient records. Prefer
        # its familiar catalog guide only when its measured extent reaches the
        # saved point; keep all candidates and the field-association disclosure.
        parent=next((o for o in candidates if re.fullmatch(r'(M|NGC|IC)\s*\d+',o['name'].strip(),re.I)),None)
        if parent and parent['id']!=first['id']:
            research=await enrich(research,parent)
            detail=research.get('object_details',{}).get(parent['id'],{})
            diameter=remote.number(detail.get('measurements',{}).get('galdim_majaxis'))
            if diameter and parent['separation_arcsec']<=diameter*30:preferred=parent['id']
    research=await enrich(research,selected_object(research,preferred))
    return compose(note,research,preferred)


def worker(ident,token):
    try:
        with LOCK:
            note=read(ident);research={**note['research'],'status':'researching','message':'Checking field labels, named objects and referenced measurements…'}
            write_research(ident,research)
        result=asyncio.run(investigate(note))
        with LOCK:
            if PENDING.get(ident)==token:write_research(ident,result)
    except Exception as error:
        with LOCK:
            try:
                note=read(ident);write_research(ident,{**note['research'],'status':'failed','message':'Research could not finish. Your image and notes are saved. Retry when online.','error':str(error)[:400]})
            except HTTPException:pass
    finally:
        with LOCK:PENDING.pop(ident,None)


def start_research(ident):
    with LOCK:
        note=read(ident)
        if note['ra'] is None or note['dec'] is None:raise HTTPException(422,'This entry needs a sky position for catalog research.')
        if ident in PENDING:return note
        if len(PENDING)>=12:raise HTTPException(429,'Notebook research is busy. Your entry is saved; retry shortly.')
        token=uuid.uuid4().hex;PENDING[ident]=token
        note=write_research(ident,{**note['research'],'status':'queued','message':'Saved. Research is queued on this PC.'})
        POOL.submit(worker,ident,token);return note


class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)


class StoryEdit(Strict):
    revision:int=Field(ge=1)
    narration:str=Field(min_length=1,max_length=3500)


class Identification(Strict):
    revision:int=Field(ge=1)
    candidate_id:str=Field(min_length=1,max_length=300)


class Selection(Strict):
    id:str=Field(pattern=r'^[a-f0-9]{32}$')
    revision:int=Field(ge=1)


class NotebookTour(Strict):
    title:str=Field(min_length=1,max_length=200)
    narrator:Literal['windows','browser','openai']='windows'
    entries:list[Selection]=Field(min_length=1,max_length=50)


@router.get('/{ident}')
def get_note(ident:str):return read(ident)


@router.post('/{ident}/research',status_code=202)
def research_note(ident:str):return start_research(ident)


@router.put('/{ident}/story')
def edit_story(ident:str,body:StoryEdit):
    with LOCK:
        note=read(ident)
        if ident in PENDING:raise HTTPException(409,'Wait for research to finish before editing the story.')
        if not body.narration.strip():raise HTTPException(422,'Enter a narration script.')
        return write_research(ident,{**note['research'],'edited_narration':body.narration.strip(),'edited_at':remote.now()},body.revision)


@router.put('/{ident}/identify')
async def identify(ident:str,body:Identification):
    with LOCK:
        note=read(ident)
        if ident in PENDING:raise HTTPException(409,'Wait for research to finish before selecting an object.')
        if not any(o['id']==body.candidate_id for o in note['research'].get('candidates',[])):raise HTTPException(422,'Select an object returned for this saved location.')
        if note['revision']!=body.revision:raise HTTPException(409,'This notebook entry changed. Reload it before saving.')
    research=await enrich(note['research'],selected_object(note['research'],body.candidate_id))
    with LOCK:
        return write_research(ident,compose(note,{**research,'selection_method':'manual'},body.candidate_id),body.revision)


@router.post('/tour')
def create_tour(body:NotebookTour):
    import expeditions
    if len({s.id for s in body.entries})!=len(body.entries):raise HTTPException(422,'Select each notebook entry once.')
    stops=[]
    with LOCK:
        for selection in body.entries:
            note=read(selection.id);r=note['research'];p=note['provenance']
            if selection.revision!=note['revision']:raise HTTPException(409,'A notebook entry changed. Refresh the selection before creating the tour.')
            if note['ra'] is None or note['dec'] is None:raise HTTPException(422,'Every tour stop needs sky coordinates.')
            text=r.get('edited_narration') or r.get('story')
            if note['id'] in PENDING or not text:raise HTTPException(409,'Finish researching or write a narration for each selected entry first.')
            image_id=p.get('image_id');sha=None
            if image_id:
                try:sha=science.metadata(image_id)['sha256']
                except (ValueError,KeyError):image_id=None
            guide=expeditions.NotebookGuide(note_id=note['id'],note_revision=note['revision'],narration=text,description=text,
                sources=r.get('sources',[]),image_id=image_id,image_sha256=sha,identity_label=r.get('identity_label','User-authored field guide'),
                researched_at=r.get('checked_at'),credit=p.get('snapshot_credit') or 'Saved sky visualization; see notebook provenance.',edited=bool(r.get('edited_narration')),narrator=body.narrator)
            view=p.get('view',p);fov=float(view.get('fov',.2));roll=float(view.get('roll',0));projection=view.get('projection','AIT')
            stops.append(expeditions.Stop(title=note['title'],ra=note['ra'],dec=note['dec'],fov=min(360,max(.001,fov)),roll=roll,
                projection=projection if projection in ('AIT','TAN','SIN') else 'AIT',survey='optical',notes=note['body'][:4000],hold=15,guide=guide))
    return expeditions.create(expeditions.Route(title=body.title,description='A narrated journey through saved discoveries. Stories and source links are preserved as they were when this tour was created.',stops=stops))
