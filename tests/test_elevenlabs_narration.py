"""Billing and credential regressions; all ElevenLabs traffic is mocked."""
import asyncio
import hashlib
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
import elevenlabs_narration as speech

MP3=b'ID3\x04\0\0\0\0\0\0'+b'\xff\xfb\x90\x64'+bytes(range(256))
KEY='test-private-elevenlabs-key'


@pytest.fixture
def app(tmp_path,monkeypatch):
    monkeypatch.setattr(speech,'ROOT',tmp_path/'audio')
    monkeypatch.setattr(speech,'KEY_FILE',tmp_path/'key.dpapi')
    monkeypatch.setattr(speech,'SETTINGS_FILE',tmp_path/'voice.json')
    monkeypatch.setattr(speech,'get_key',lambda:KEY)
    monkeypatch.setattr(speech,'_inflight',{})
    def no_network():raise AssertionError('Unexpected paid request')
    monkeypatch.setattr(speech,'make_client',no_network)
    app=FastAPI();app.include_router(speech.router);return app


def mock_api(monkeypatch,handler):
    monkeypatch.setattr(speech,'make_client',lambda:httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def success(request):return httpx.Response(200,content=MP3,headers={'content-type':'audio/mpeg','request-id':'request-test'})


def test_paid_once_cached_without_key_after_restart_and_whitespace_layout_changes(app,monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request)
        assert request.url.path.endswith('/'+speech.DEFAULT_VOICE)
        assert request.url.params['output_format']=='mp3_44100_128'
        assert request.headers['xi-api-key']==KEY and 'authorization' not in request.headers
        payload=json.loads(request.content)
        assert payload=={'text':'Visit NGC 1635.','model_id':speech.MODEL,'voice_settings':speech.VOICE_SETTINGS}
        return success(request)
    mock_api(monkeypatch,handler)
    with TestClient(app) as c:
        first=c.post('/api/narration/elevenlabs/clip',json={'text':'Visit\nNGC 1635.'});assert first.status_code==200
        clip=first.json();assert clip['cached'] is False
        assert c.get(clip['url']).content==MP3
    speech._inflight.clear()
    monkeypatch.setattr(speech,'get_key',lambda:None)
    monkeypatch.setattr(speech,'make_client',lambda:pytest.fail('Replay must never contact ElevenLabs'))
    with TestClient(app) as c:
        replay=c.post('/api/narration/elevenlabs/clip',json={'text':' Visit NGC   1635. '})
        assert replay.json()=={**clip,'cached':True}
        assert c.get(clip['url']).content==MP3
        assert c.get('/api/narration/elevenlabs/status').json()['cached_clips']==1
    assert len(calls)==1
    meta=json.loads(next(speech.ROOT.glob('*.json')).read_text())
    assert meta['identity']['voice_id']==speech.DEFAULT_VOICE and meta['sha256']==hashlib.sha256(MP3).hexdigest()
    assert KEY not in json.dumps(meta)


def test_different_text_or_voice_has_a_distinct_audio_identity(app):
    a=speech.identity(speech.ClipRequest(text='A galaxy.'),speech.DEFAULT_VOICE)
    b=speech.identity(speech.ClipRequest(text='Another galaxy.'),speech.DEFAULT_VOICE)
    c=speech.identity(speech.ClipRequest(text='A galaxy.'),'AnotherVoice1234')
    assert len({speech.cache_key(s) for s in (a,b,c)})==3


def test_concurrent_requests_and_cancelled_waiter_share_one_generation(app,monkeypatch):
    calls=[]
    async def scenario():
        started=asyncio.Event();finish=asyncio.Event()
        async def handler(request):calls.append(request);started.set();await finish.wait();return success(request)
        mock_api(monkeypatch,handler)
        one=asyncio.create_task(speech.clip(speech.ClipRequest(text='Same story')))
        await started.wait()
        two=asyncio.create_task(speech.clip(speech.ClipRequest(text='Same story')))
        await asyncio.sleep(0);one.cancel()
        with pytest.raises(asyncio.CancelledError):await one
        finish.set();result=await two
        assert result['cached'] is False
        assert (await speech.clip(speech.ClipRequest(text='Same story')))['cached'] is True
    asyncio.run(scenario());assert len(calls)==1


def test_interrupted_request_does_not_silently_charge_again_after_restart(app,monkeypatch):
    calls=[]
    def handler(request):calls.append(request);raise httpx.ReadTimeout('private details '+KEY)
    mock_api(monkeypatch,handler)
    with TestClient(app) as c:
        response=c.post('/api/narration/elevenlabs/clip',json={'text':'Interrupted story'})
        assert response.status_code==504 and KEY not in response.text
    speech._inflight.clear()
    with TestClient(app) as c:
        response=c.post('/api/narration/elevenlabs/clip',json={'text':'Interrupted story'})
        assert response.status_code==409 and 'repeat billing' in response.text
    assert len(calls)==1


@pytest.mark.parametrize('code',[401,403,404,429,500])
def test_remote_error_details_do_not_expose_credentials(app,monkeypatch,code):
    calls=[]
    def handler(request):calls.append(request);return httpx.Response(code,json={'secret':KEY})
    mock_api(monkeypatch,handler)
    with TestClient(app) as c:
        response=c.post('/api/narration/elevenlabs/clip',json={'text':'Failure'})
        assert response.status_code in (401,403,429,502) and KEY not in response.text
    assert len(calls)==1


def test_metadata_save_failure_recovers_completed_audio_without_paid_regeneration(app,monkeypatch):
    calls=[];original=speech.atomic_json
    def save(path,value):
        if value.get('sha256'):raise OSError('disk full')
        return original(path,value)
    monkeypatch.setattr(speech,'atomic_json',save)
    def handler(request):calls.append(request);return success(request)
    mock_api(monkeypatch,handler)
    with TestClient(app) as c:
        assert c.post('/api/narration/elevenlabs/clip',json={'text':'Keep this audio'}).status_code==500
        monkeypatch.setattr(speech,'atomic_json',original)
        response=c.post('/api/narration/elevenlabs/clip',json={'text':'Keep this audio'})
        assert response.status_code==200 and response.json()['cached'] is True
    assert len(calls)==1


def test_corrupt_saved_audio_is_blocked_instead_of_billed_again(app,monkeypatch):
    calls=[]
    def handler(request):calls.append(request);return success(request)
    mock_api(monkeypatch,handler)
    with TestClient(app) as c:
        result=c.post('/api/narration/elevenlabs/clip',json={'text':'Saved story'}).json()
        path=speech.ROOT/(result['cache_key']+'.mp3');path.write_bytes(MP3[:-1]+b'x')
        response=c.post('/api/narration/elevenlabs/clip',json={'text':'Saved story'})
        assert response.status_code==409 and 'repair' in response.text
    assert len(calls)==1


def test_connect_checks_exact_voice_and_only_persists_protected_key(app,monkeypatch):
    def handler(request):
        assert request.method=='GET' and request.url.path=='/v1/voices/'+speech.DEFAULT_VOICE
        return httpx.Response(200,json={'voice_id':speech.DEFAULT_VOICE,'name':'Test Narrator'})
    mock_api(monkeypatch,handler)
    monkeypatch.setattr(speech.cloud_ai,'protect',lambda data:b'ENCRYPTED')
    with TestClient(app) as c:
        r=c.post('/api/narration/elevenlabs/connect',json={'api_key':KEY})
        assert r.status_code==200 and KEY not in r.text and r.json()['voice_name']=='Test Narrator'
        assert speech.KEY_FILE.read_bytes()==b'ENCRYPTED'
        assert KEY not in speech.SETTINGS_FILE.read_text()
        assert c.delete('/api/narration/elevenlabs/connection').status_code==200
        assert not speech.KEY_FILE.exists()


@pytest.mark.parametrize('payload',[{'text':''},{'text':' '},{'text':'x'*3501},{'text':'a','voice_id':'arbitrary'},{'text':123}])
def test_invalid_generation_requests_never_reach_provider(app,payload):
    with TestClient(app) as c:assert c.post('/api/narration/elevenlabs/clip',json=payload).status_code==422


def test_missing_key_and_unsafe_audio_paths_do_not_contact_provider(app,monkeypatch):
    monkeypatch.setattr(speech,'get_key',lambda:None)
    with TestClient(app) as c:
        assert c.post('/api/narration/elevenlabs/clip',json={'text':'New story'}).status_code==409
        assert c.get('/api/narration/elevenlabs/audio/not-a-hash.mp3').status_code==404
    assert not list(speech.ROOT.glob('*.attempt.json'))


def test_malformed_settings_and_metadata_fail_safely_without_new_charge(app,monkeypatch):
    speech.SETTINGS_FILE.write_text('[]')
    assert speech.settings()['voice_id']==speech.DEFAULT_VOICE
    calls=[]
    def handler(request):calls.append(request);return success(request)
    mock_api(monkeypatch,handler)
    with TestClient(app) as c:
        result=c.post('/api/narration/elevenlabs/clip',json={'text':'Preserve this recording'}).json()
        (speech.ROOT/(result['cache_key']+'.json')).write_text('[]')
        response=c.post('/api/narration/elevenlabs/clip',json={'text':'Preserve this recording'})
        assert response.status_code==409 and 'repair' in response.text
    assert len(calls)==1
