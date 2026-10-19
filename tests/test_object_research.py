"""Object biography lifecycle and billing boundaries, with all provider traffic mocked."""
import asyncio
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

import object_research as objects
from test_tour_stories import STORY, output
from test_elevenlabs_narration import MP3

TARGET={'id':'simbad:M  16','name':'M 16','catalog':'SIMBAD','type':'Nebula',
        'ra':274.7,'dec':-13.8,'source_url':'https://simbad.cds.unistra.fr/simbad/sim-id?Ident=M16'}
VIEW={'ra':99,'dec':22,'fov':.1,'survey':'2mass'}


@pytest.fixture
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(objects,'ROOT',tmp_path/'objects')
    monkeypatch.setattr(objects,'_inflight',{})
    monkeypatch.setattr(objects.tour_stories,'ROOT',tmp_path/'stories')
    monkeypatch.setattr(objects.tour_stories,'_inflight',{})
    monkeypatch.setattr(objects.tour_stories,'_limit',asyncio.Semaphore(2))
    monkeypatch.setattr(objects.expeditions,'PATH',tmp_path/'routes.sqlite3')
    monkeypatch.setattr(objects.voice,'ROOT',tmp_path/'audio')
    monkeypatch.setattr(objects.voice,'_inflight',{})
    monkeypatch.setattr(objects.voice,'settings',lambda:{'voice_id':objects.voice.DEFAULT_VOICE})
    monkeypatch.setattr(objects.voice,'get_key',lambda:'test-voice-key')
    monkeypatch.setattr(objects.tour_stories.cloud_ai,'get_key',lambda:'test-openai-key')
    async def identify(context):return {'name':context['target_hint']}
    monkeypatch.setattr(objects.tour_stories,'identify',identify)
    monkeypatch.setattr(objects.tour_stories,'make_client',lambda:pytest.fail('Unexpected OpenAI request'))
    monkeypatch.setattr(objects.voice,'make_client',lambda:pytest.fail('Unexpected ElevenLabs request'))
    app=FastAPI();app.include_router(objects.router);app.include_router(objects.expeditions.router);app.include_router(objects.voice.router)
    return app


def providers(monkeypatch):
    calls={'research':[],'voice':[]}
    def research(request):
        payload=json.loads(request.content);calls['research'].append(payload)
        assert json.loads(payload['input'])['field']['scope']=='object'
        assert 'permanent OBJECT biography' in payload['instructions']
        return httpx.Response(200,json=output())
    def voice(request):
        calls['voice'].append(json.loads(request.content));return httpx.Response(200,content=MP3,headers={'content-type':'audio/mpeg'})
    monkeypatch.setattr(objects.tour_stories,'make_client',lambda:httpx.AsyncClient(transport=httpx.MockTransport(research)))
    monkeypatch.setattr(objects.voice,'make_client',lambda:httpx.AsyncClient(transport=httpx.MockTransport(voice)))
    return calls


def research(c):
    result=c.post('/api/object-research/research',json={'target':TARGET})
    assert result.status_code==200,result.text
    return result.json()


def test_lookup_is_read_only_and_research_survives_without_narration_or_keys(isolated,monkeypatch):
    calls=providers(monkeypatch)
    with TestClient(isolated) as c:
        empty=c.post('/api/object-research/lookup',json={'target':TARGET}).json()
        assert empty['status']=='empty' and not list(objects.ROOT.glob('*'))
        first=research(c);assert first['research']['story']==STORY and first['audio'] is None
    monkeypatch.setattr(objects.tour_stories.cloud_ai,'get_key',lambda:pytest.fail('Saved story must need no key'))
    monkeypatch.setattr(objects.voice,'get_key',lambda:pytest.fail('Reading a card must need no voice key'))
    objects._inflight.clear();objects.tour_stories._inflight.clear()
    with TestClient(isolated) as c:
        again=c.post('/api/object-research/lookup',json={'target':{**TARGET,'id':'SIMBAD:M 16','ra':274.70001}}).json()
        assert again['id']==first['id'] and again['research']==first['research'] and again['status']=='ready'
        assert research(c)['research']==first['research']
    assert len(calls['research'])==1 and not calls['voice']


def test_audio_and_exported_tours_reuse_exact_saved_script_and_pinned_voice(isolated,monkeypatch):
    calls=providers(monkeypatch)
    with TestClient(isolated) as c:
        record=research(c);base='/api/object-research/'+record['id'];text=record['research']['narration']
        # Adding a tour does not implicitly create paid audio.
        route=c.post(base+'/tour',json={'view':VIEW,'title':'My object tour'}).json()
        guide=route['stops'][0]['guide'];assert guide['narration']==text and not calls['voice']
        assert route['stops'][0]['ra']==TARGET['ra'] and route['stops'][0]['dec']==TARGET['dec']
        assert route['media'][0]['kind']=='object-research' and route['media'][0]['narration']==text
        response=c.post(base+'/narration');assert response.status_code==200,response.text
        first=response.json();assert first['cached'] is False
        assert calls['voice'][0]['text']==' '.join(text.split())
        assert c.get(base).json()['audio']['url']==first['url']
        assert c.get(first['url']).content==MP3
        # A later preference change must not change an approved recording's voice.
        monkeypatch.setattr(objects.voice,'settings',lambda:{'voice_id':'AnotherVoice12345'})
        monkeypatch.setattr(objects.voice,'get_key',lambda:pytest.fail('Replay needs no key'))
        assert c.post(base+'/narration').json()['cached'] is True
        exported={'schema':'universe-explorer-route','version':1,'route':{k:route[k] for k in ('title','description','kind','stops','track')}}
        imported=c.post('/api/navigation/import',json=exported);assert imported.status_code==200,imported.text
        assert imported.json()['media'][0]['narration']==text
        objects.path_for(record['id']).unlink()  # Export is self-contained, even on another installation.
        replay=c.post('/api/object-research/clip',json=guide).json()
        assert replay['cached'] and replay['url']==first['url']
    assert len(calls['research'])==len(calls['voice'])==1


def test_audio_failure_never_changes_saved_research(isolated,monkeypatch):
    providers(monkeypatch)
    with TestClient(isolated) as c:
        record=research(c);base='/api/object-research/'+record['id']
        monkeypatch.setattr(objects.voice,'get_key',lambda:None)
        assert c.post(base+'/narration').status_code==409
        assert c.get(base).json()['research']==record['research']


def test_existing_tour_append_checks_revision_and_preserves_previous_stops(isolated,monkeypatch):
    providers(monkeypatch)
    with TestClient(isolated) as c:
        record=research(c);url='/api/object-research/'+record['id']+'/tour'
        original=c.post('/api/navigation/routes',json={'title':'Keep my route','stops':[{'title':'My stop','ra':1,'dec':2}]}).json()
        payload={'view':VIEW,'route_id':original['id'],'route_revision':original['revision']}
        updated=c.post(url,json=payload);assert updated.status_code==200,updated.text
        assert updated.json()['stops'][0]==original['stops'][0] and len(updated.json()['stops'])==2
        assert c.post(url,json=payload).status_code==409
        assert len(c.get('/api/navigation/routes/'+original['id']).json()['stops'])==2
        recorded=c.post('/api/navigation/routes',json={'title':'Recording','kind':'recording'}).json()
        assert c.post(url,json={**payload,'route_id':recorded['id'],'route_revision':recorded['revision']}).status_code==422


def test_unfinished_research_requires_explicit_retry(isolated,monkeypatch):
    calls=[]
    def fail(request):calls.append(request);raise httpx.ReadTimeout('private-test-key')
    monkeypatch.setattr(objects.tour_stories,'make_client',lambda:httpx.AsyncClient(transport=httpx.MockTransport(fail)))
    with TestClient(isolated) as c:
        response=c.post('/api/object-research/research',json={'target':TARGET})
        assert response.status_code==504 and 'private-test-key' not in response.text
        assert c.post('/api/object-research/research',json={'target':TARGET}).status_code==409
        assert c.post('/api/object-research/lookup',json={'target':TARGET}).json()['status']=='unfinished'
        providers(monkeypatch)
        assert c.post('/api/object-research/research',json={'target':TARGET,'retry':True}).status_code==200
    assert len(calls)==1


def test_cancelling_navigation_does_not_cancel_saved_research(isolated,monkeypatch):
    async def scenario():
        started=asyncio.Event();release=asyncio.Event();calls=[]
        async def handler(request):calls.append(request);started.set();await release.wait();return httpx.Response(200,json=output())
        monkeypatch.setattr(objects.tour_stories,'make_client',lambda:httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        one=asyncio.create_task(objects.research(objects.Research(target=TARGET)));await started.wait()
        two=asyncio.create_task(objects.research(objects.Research(target=TARGET)));await asyncio.sleep(0)
        one.cancel()
        with pytest.raises(asyncio.CancelledError):await one
        release.set();record=await two
        assert objects.read(record['id'])['research']['story']==STORY and len(calls)==1
    asyncio.run(scenario())


def test_invalid_identity_and_damaged_research_cannot_trigger_generation(isolated):
    with TestClient(isolated) as c:
        assert c.post('/api/object-research/research',json={'target':{**TARGET,'ra':999}}).status_code==422
        ident=objects.object_id(objects.Target(**TARGET));objects.ROOT.mkdir()
        objects.path_for(ident).write_text('{broken',encoding='utf-8')
        assert c.post('/api/object-research/research',json={'target':TARGET}).status_code==409
        assert c.post('/api/object-research/'+('a'*64)+'/narration').status_code==409
