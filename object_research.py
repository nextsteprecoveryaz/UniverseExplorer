"""Permanent object stories, independent of notebooks, tours and paid audio."""
import asyncio
import hashlib
import json
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException
from pydantic import Field

import elevenlabs_narration as voice
import expeditions
from integrations import now
import tour_stories

ROOT=Path(__file__).parent/'data'/'object-research'
router=APIRouter(prefix='/api/object-research',tags=['Saved object research'])
_inflight={}


class Target(expeditions.Strict):
    id:str=Field(min_length=1,max_length=400)
    name:str=Field(min_length=1,max_length=200)
    catalog:str=Field(min_length=1,max_length=100)
    ra:float=Field(ge=0,lt=360)
    dec:float=Field(ge=-90,le=90)
    type:str=Field(default='',max_length=200)
    source_url:str=Field(default='',max_length=2000)


class Lookup(expeditions.Strict):
    target:Target


class Research(Lookup):
    retry:bool=False


class AddToTour(expeditions.Strict):
    view:expeditions.View
    route_id:str|None=Field(default=None,pattern=r'^[a-f0-9]{32}$')
    route_revision:int|None=Field(default=None,ge=1)
    title:str=Field(default='My object tour',min_length=1,max_length=200)


def object_id(target):
    # Canonical catalog identifiers survive panning, zoom, survey changes and restarts.
    canonical=lambda s:re.sub(r'\b(m|ngc|ic)[ -]+(\d+)\b',r'\1 \2',' '.join(s.casefold().split()))
    return hashlib.sha256(json.dumps([canonical(target.catalog),canonical(target.id)],ensure_ascii=False).encode()).hexdigest()


def path_for(ident):
    if not re.fullmatch(r'[a-f0-9]{64}',ident):raise HTTPException(404,'Object research not found.')
    return ROOT/(ident+'.json')


def read(ident):
    path=path_for(ident)
    if not path.exists():return None
    try:
        saved=json.loads(path.read_text(encoding='utf-8'))
        if object_id(Target.model_validate(saved['target']))!=ident or saved['id']!=ident:raise ValueError()
        if saved.get('research'):
            r=saved['research']
            if tour_stories.spoken_text(tour_stories.Story.model_validate(r['story']))!=r['narration']:raise ValueError()
        return saved
    except (ValueError,TypeError,KeyError,OSError):
        raise HTTPException(409,'Saved object research needs repair. Keep its files; it will not be overwritten or regenerated automatically.') from None


def write(saved):
    try:voice.atomic_json(path_for(saved['id']),saved)
    except OSError:raise HTTPException(500,'Could not save object research on this PC. Check available disk space.') from None


def require_research(ident):
    saved=read(ident)
    if not saved or not saved.get('research'):raise HTTPException(409,'Research this object first. Its saved story is used unchanged for narration and tours.')
    return saved


def document(saved,ident):
    if not saved:return {'id':ident,'status':'empty','research':None,'audio':None,'error':None}
    result={**saved,'status':'ready' if saved.get('research') else 'researching' if ident in _inflight else 'unfinished',
            'audio':None,'audio_error':None,'audio_status':'empty'}
    if saved.get('research'):
        spec=voice.identity(voice.ClipRequest(text=saved['research']['narration']),saved['voice_id'])
        key=voice.cache_key(spec)
        try:result['audio']=voice.cached_clip(spec,key)
        except HTTPException as error:result['audio_error']=error.detail
        result['audio_status']='ready' if result['audio'] else 'creating' if key in voice._inflight else 'empty'
    return result


@router.post('/lookup')
async def lookup(body:Lookup):
    ident=object_id(body.target)
    return document(recover_saved(read(ident)),ident)


def recover_saved(saved):
    # Reopening a failed card can recover paid-for output after a parser fix.
    # This never requests new research or audio and never changes a ready story.
    if not saved or saved.get('research') or saved['id'] in _inflight:return saved
    try:research=tour_stories.recover_cache(saved['context'])
    except tour_stories.ResearchValidationError as error:
        message=tour_stories.validation_message(error).replace('Replay narration','Retry research')
        if saved.get('error')!=message:
            saved={**saved,'error':message};write(saved)
        return saved
    except OSError:raise HTTPException(500,'Could not recover saved research on this PC. Check available disk space.') from None
    if research:
        saved={**saved,'research':research,'error':None,'updated_at':now()}
        write(saved)
    return saved


async def generate(saved,retry):
    try:
        research=await tour_stories.research_context(saved['context'],retry)
        saved={**saved,'research':research,'error':None,'updated_at':now()}
        write(saved)
        return document(saved,saved['id'])
    except HTTPException as error:
        # Research is durable before audio is even possible. A failure cannot erase it.
        saved['error']=str(error.detail).replace('Replay narration','Retry research').replace('Replay explicitly','Retry research explicitly')
        write(saved)
        raise HTTPException(error.status_code,saved['error']) from None


@router.post('/research')
async def research(body:Research):
    ident=object_id(body.target);saved=read(ident)
    if saved and saved.get('research'):return document(saved,ident)
    task=_inflight.get(ident)
    if task is None:
        if saved is None:
            target=body.target.model_dump()
            context={'version':tour_stories.VERSION,'scope':'object','ra':target['ra'],'dec':target['dec'],'fov':.01,
                     'target_hint':tour_stories.normalize_name(target['name']),'catalog':target['catalog'],
                     'classification':target['type'],'publisher_url':target['source_url']}
            saved={'id':ident,'revision':1,'target':target,'context':context,'research':None,'error':None,
                   'voice_id':voice.settings()['voice_id'],'created_at':now()}
            write(saved)
        task=asyncio.create_task(generate(saved,body.retry));_inflight[ident]=task
        def completed(done):
            if _inflight.get(ident) is done:_inflight.pop(ident,None)
            if not done.cancelled():done.exception()
        task.add_done_callback(completed)
    return await asyncio.shield(task)


@router.post('/clip')
async def tour_clip(guide:expeditions.ObjectGuide):
    # Exported tours contain the script and voice; they also work without the object library.
    return await voice.clip_for_voice(voice.ClipRequest(text=guide.narration),guide.voice_id)


@router.get('/{ident}')
async def get_research(ident:str):
    saved=recover_saved(read(ident))
    if not saved:raise HTTPException(404,'Object research not found.')
    return document(saved,ident)


@router.post('/{ident}/narration')
async def create_narration(ident:str):
    saved=require_research(ident)
    return await voice.clip_for_voice(voice.ClipRequest(text=saved['research']['narration']),saved['voice_id'])


@router.post('/{ident}/tour')
def add_to_tour(ident:str,body:AddToTour):
    saved=require_research(ident);r=saved['research'];target=saved['target']
    guide=expeditions.ObjectGuide(research_id=ident,research_revision=saved['revision'],narration=r['narration'],
        description=r['narration'],sources=r['sources'],identity_label=target['name'],researched_at=r['created_at'],voice_id=saved['voice_id'])
    view=body.view.model_dump();view.update(ra=target['ra'],dec=target['dec'])
    stop=expeditions.Stop(**view,title=r['story']['title'],guide=guide,hold=30)
    if not body.route_id:
        return expeditions.create(expeditions.Route(title=body.title,description='Saved object stories with source links and reusable ElevenLabs narration.',stops=[stop]))
    route=expeditions.read(body.route_id)
    if route['kind']!='waypoints':raise HTTPException(422,'Choose a waypoint tour; recordings cannot contain object stops.')
    if route['revision']!=body.route_revision:raise HTTPException(409,'This tour changed. Reopen Add to tour before saving.')
    if len(route['stops'])>=100:raise HTTPException(422,'This tour already has 100 stops. Choose another tour.')
    payload={k:route[k] for k in ('title','description','kind','stops','track','revision')}
    payload['stops']=[*payload['stops'],stop.model_dump()]
    return expeditions.update_route(body.route_id,expeditions.Update(**payload))
