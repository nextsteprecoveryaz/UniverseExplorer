import json
import wave
import pytest
from fastapi.testclient import TestClient
from app import app
import local_narration as local

@pytest.fixture
def speech(tmp_path,monkeypatch):
    monkeypatch.setattr(local,'ROOT',tmp_path);calls=[]
    def synthesize(path):
        config=json.loads(path.read_text(encoding='utf-8'));calls.append(config)
        with wave.open(config['output'],'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(22050);wav.writeframes(b'\x10\x10'*22050)
        return {'voice':'Local test voice'}
    monkeypatch.setattr(local,'synthesize',synthesize)
    return TestClient(app),calls

def test_local_speech_caches_wav_and_serves_it_without_cloud_access(speech):
    client,calls=speech
    first=client.post('/api/narration/local/clip',json={'text':'An astronomy story.'});assert first.status_code==200
    result=first.json();assert result['cached'] is False and result['voice']=='Local test voice'
    second=client.post('/api/narration/local/clip',json={'text':'An astronomy story.'}).json()
    assert second['cached'] is True and second['url']==result['url'] and len(calls)==1
    audio=client.get(result['url']);assert audio.status_code==200 and audio.content[:4]==b'RIFF'
    assert audio.headers['content-type']=='audio/wav'

def test_speech_text_remains_literal_in_json_and_temporary_files_are_removed(speech):
    client,calls=speech;text='$(Get-Secret); <speak>Hello</speak> "star" — galaxy'
    result=client.post('/api/narration/local/clip',json={'text':text});assert result.status_code==200
    assert calls[0]['text']==text
    assert len(list(local.ROOT.glob('*.json')))==1 and not list(local.ROOT.glob('*.meta'))

def test_local_speech_validation_and_missing_clip(speech):
    client,_=speech
    for body in ({'text':''},{'text':'a'*3501},{'text':'hello','voice':'untrusted'}):
        assert client.post('/api/narration/local/clip',json=body).status_code==422
    assert client.get('/api/narration/local/audio/'+('a'*64)+'.wav').status_code==404
    assert client.get('/api/narration/local/audio/unknown.wav').status_code==404

def test_failed_local_generation_removes_requests_and_cannot_publish_audio(speech,monkeypatch):
    client,_=speech
    def fail(path):raise local.HTTPException(503,'No local voice')
    monkeypatch.setattr(local,'synthesize',fail)
    assert client.post('/api/narration/local/clip',json={'text':'Hello'}).status_code==503
    assert not list(local.ROOT.iterdir())
