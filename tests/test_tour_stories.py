import asyncio
from copy import deepcopy
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

import tour_stories as stories

URL='https://science.nasa.gov/mission/hubble/science/explore-the-night-sky/hubble-messier-catalog/messier-16/'
TEXTS=[
    'Messier sixteen is also known as the Eagle Nebula, a stellar nursery in the constellation Serpens. Its young stars illuminate clouds of gas and dust. The region gives astronomers a chance to investigate how stars form together and how the most massive stars change their surroundings.',
    'The famous Pillars of Creation are a small part of this wider nebula. Dense material inside such clouds can collapse under gravity to form new stars. Radiation and winds from nearby stars also sculpt and erode the clouds, so star formation and destruction happen side by side.',
    'The displayed map uses near-infrared survey light from ground-based telescopes. That wavelength can reveal stars hidden by some of the dust that blocks visible light. It does not mean every star in the field belongs to the nebula, or that this survey resolves the same detail as Webb.'
]
STORY={'title':'Eagle Nebula · Messier 16','identified':True,'paragraphs':[{'text':t,'source_urls':[URL]} for t in TEXTS]}
STOP={'title':'M-16','ra':274.72991,'dec':-13.85172,'fov':.2191,'survey':'2mass','source':{'kind':'mast','id':'123'}}


@pytest.fixture
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(stories,'ROOT',tmp_path/'stories')
    monkeypatch.setattr(stories,'_inflight',{})
    monkeypatch.setattr(stories,'_limit',asyncio.Semaphore(2))
    monkeypatch.setattr(stories.cloud_ai,'get_key',lambda:'secret-test-key')
    monkeypatch.setattr(stories.expeditions,'resolve_source',lambda ref:{'title':'M-16','description':'JWST Cycle 1 Outreach Campaign','ra':STOP['ra'],'dec':STOP['dec'],'source_url':URL})
    async def identify(context):return {'name':'M 16','constellation':'Serpens'}
    monkeypatch.setattr(stories,'identify',identify)
    monkeypatch.setattr(stories,'make_client',lambda:pytest.fail('Unexpected OpenAI request'))
    app=FastAPI();app.include_router(stories.router)
    return app


def output(story=None):
    return {'id':'resp-test','status':'completed','output':[
        {'type':'web_search_call','action':{'sources':[{'url':URL,'title':'NASA · Eagle Nebula'}]}},
        {'type':'message','content':[{'type':'output_text','text':json.dumps(story or STORY),'annotations':[]}]}]}


def mock(monkeypatch,handler):
    monkeypatch.setattr(stories,'make_client',lambda:httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_openai_research_precedes_cached_replay_without_key_or_network(isolated,monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request);body=json.loads(request.content)
        assert request.url=='https://api.openai.com/v1/responses'
        assert body['store'] is False and body['model']==stories.MODEL
        assert body['tools'][0]['type']=='web_search' and 'nasa.gov' in body['tools'][0]['filters']['allowed_domains']
        assert body['text']['format']['strict'] is True and body['max_tool_calls']==4
        assert 'near-infrared' in body['input'] and 'M 16' in body['input']
        return httpx.Response(200,json=output())
    mock(monkeypatch,handler)
    with TestClient(isolated) as c:
        r=c.post('/api/navigation/stories',json={'stop':STOP});assert r.status_code==200,r.text
        first=r.json();assert first['cached'] is False
        assert first['narration']=='\n\n'.join(TEXTS) and first['sources'][0]['url']==URL
        assert 'Campaign' not in first['narration'] and URL not in first['narration']
    monkeypatch.setattr(stories.cloud_ai,'get_key',lambda:pytest.fail('Cache needs no credential'))
    monkeypatch.setattr(stories,'make_client',lambda:pytest.fail('Cache needs no OpenAI request'))
    with TestClient(isolated) as c:
        again=c.post('/api/navigation/stories',json={'stop':{**STOP,'hold':30,'travel':8},'retry':True})
        assert again.json()=={**first,'cached':True}
    assert len(calls)==1


@pytest.mark.parametrize('change',['labels','links','uncited','incomplete','short','sentence'])
def test_unusable_research_is_never_cached_or_returned_as_narration(isolated,monkeypatch,change):
    story=deepcopy(STORY)
    if change=='labels':story['paragraphs'][0]['text']+=' JWST Cycle 1 Outreach Campaign.'
    if change=='links':story['paragraphs'][0]['text']+=' Read https://science.nasa.gov.'
    if change=='uncited':story['paragraphs'][0]['source_urls']=['https://science.nasa.gov/invented-source']
    if change=='short':story['paragraphs']=[{'text':'This is a short and insufficient sentence describing the field.','source_urls':[URL]}]*3
    if change=='sentence':story['paragraphs'][0]['text']=TEXTS[0][:-1]
    response=output(story)
    if change=='incomplete':response['status']='incomplete'
    calls=[]
    def handler(request):calls.append(request);return httpx.Response(200,json=response)
    mock(monkeypatch,handler)
    with TestClient(isolated) as c:
        r=c.post('/api/navigation/stories',json={'stop':STOP});assert r.status_code==502
        again=c.post('/api/navigation/stories',json={'stop':STOP});assert again.status_code==409
    assert len(calls)==1 and not [p for p in stories.ROOT.glob('*.json') if not p.name.endswith(('.attempt.json','.response.json'))]


def test_uncertain_failure_requires_explicit_retry_and_never_echoes_key(isolated,monkeypatch):
    calls=[]
    def failed(request):calls.append(request);raise httpx.ReadTimeout('secret-test-key')
    mock(monkeypatch,failed)
    with TestClient(isolated) as c:
        r=c.post('/api/navigation/stories',json={'stop':STOP});assert r.status_code==504 and 'secret-test-key' not in r.text
        assert c.post('/api/navigation/stories',json={'stop':STOP}).status_code==409
        mock(monkeypatch,lambda r:httpx.Response(200,json=output()))
        assert c.post('/api/navigation/stories',json={'stop':STOP,'retry':True}).status_code==200
    assert len(calls)==1


def test_concurrent_requests_and_navigation_cancel_share_generation(isolated,monkeypatch):
    calls=[]
    async def scenario():
        started=asyncio.Event();release=asyncio.Event()
        async def handler(request):calls.append(request);started.set();await release.wait();return httpx.Response(200,json=output())
        mock(monkeypatch,handler)
        one=asyncio.create_task(stories.story(stories.Request(stop=STOP)))
        await started.wait()
        two=asyncio.create_task(stories.story(stories.Request(stop=STOP)))
        await asyncio.sleep(0);one.cancel()
        with pytest.raises(asyncio.CancelledError):await one
        release.set();assert (await two)['narration']=='\n\n'.join(TEXTS)
    asyncio.run(scenario());assert len(calls)==1


def test_survey_or_location_changes_story_cache_identity(isolated):
    a=stories.context_for(stories.expeditions.Stop(**STOP))
    b=stories.context_for(stories.expeditions.Stop(**{**STOP,'survey':'optical'}))
    c=stories.context_for(stories.expeditions.Stop(**{**STOP,'ra':12}))
    assert len({stories.cache_key(v) for v in (a,b,c)})==3
    assert c['source_moved'] and c['target_hint']=='' and c['caption']==''


def test_manual_notebook_script_is_preserved_without_research(isolated,monkeypatch):
    monkeypatch.setattr(stories.cloud_ai,'get_key',lambda:pytest.fail('Must preserve manual script without credentials'))
    guide={'note_id':'a'*32,'note_revision':2,'narration':'My carefully written narration.','description':'My story.','edited':True}
    with TestClient(isolated) as c:
        r=c.post('/api/navigation/stories',json={'stop':{**STOP,'guide':guide}})
        assert r.status_code==200 and r.json()['preserved'] and r.json()['narration']==guide['narration']


def test_missing_key_and_invalid_inputs_do_not_make_paid_requests(isolated,monkeypatch):
    monkeypatch.setattr(stories.cloud_ai,'get_key',lambda:None)
    with TestClient(isolated) as c:
        assert c.post('/api/navigation/stories',json={'stop':STOP}).status_code==409
        for stop in ({**STOP,'ra':999},{**STOP,'survey':'webb-color'},{**STOP,'source':{'kind':'mast','id':'../key'}}):
            assert c.post('/api/navigation/stories',json={'stop':stop}).status_code==422
    assert not list(stories.ROOT.glob('*.attempt.json'))


@pytest.mark.parametrize('url',['https://science.nasa.gov.evil.test','https://nasa.gov@evil.test','http://science.nasa.gov','https://localhost/','file:///secret'])
def test_source_links_are_restricted_to_primary_publishers(url):assert not stories.source_url(url)


def test_completed_provider_response_is_recoverable_without_credentials_or_rebilling(isolated,monkeypatch):
    context=stories.context_for(stories.expeditions.Stop(**STOP));key=stories.cache_key(context)
    stories.atomic_json(stories.ROOT/(key+'.response.json'),{'context':context,'catalog_context':{},'response':output()})
    stories.atomic_json(stories.ROOT/(key+'.attempt.json'),{'context':context})
    monkeypatch.setattr(stories.cloud_ai,'get_key',lambda:pytest.fail('Recovery must not read credentials'))
    with TestClient(isolated) as c:
        r=c.post('/api/navigation/stories',json={'stop':STOP});assert r.status_code==200,r.text
        assert r.json()['cached'] and r.json()['narration']=='\n\n'.join(TEXTS)
    assert (stories.ROOT/(key+'.json')).exists() and not (stories.ROOT/(key+'.attempt.json')).exists()
