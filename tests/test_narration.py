"""Narration requests are mocked: this suite never calls a paid API."""
import asyncio
import hashlib
import json

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import narration


MP3 = b'ID3\x04\x00\x00\x00\x00\x00\x00' + b'\xff\xfb\x90\x64' + bytes(range(256))
FAKE_KEY = 'test-secret-never-persist'


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(narration, 'ROOT', tmp_path / 'narration')
    monkeypatch.setattr(narration.cloud_ai, 'get_key', lambda: FAKE_KEY)
    narration._inflight.clear()

    def no_network():
        raise AssertionError('Unexpected request: tests must install a mock transport.')

    monkeypatch.setattr(narration, 'make_client', no_network)
    application = FastAPI()
    application.include_router(narration.router)
    return application


def mock_api(monkeypatch, handler):
    monkeypatch.setattr(narration, 'make_client',
                        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def success(_request):
    return httpx.Response(200, content=MP3,
                          headers={'Content-Type': 'audio/mpeg', 'x-request-id': 'req_test-123'})


def test_status_exposes_no_credentials_and_reports_available_voices(app):
    with TestClient(app) as client:
        response = client.get('/api/narration/status')
    assert response.status_code == 200
    value = response.json()
    assert value['configured'] is True
    assert value['voices'] == ['cedar', 'marin', 'coral']
    assert value['default_voice'] == 'cedar'
    assert value['model'] == 'gpt-4o-mini-tts'
    assert value['max_text_chars'] == 3500
    assert 'AI-generated' in value['disclosure']
    assert FAKE_KEY not in response.text


def test_generation_saves_audio_provenance_and_reuses_it_without_key(app, monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url == narration.ENDPOINT
        assert request.headers['Authorization'] == 'Bearer ' + FAKE_KEY
        payload = json.loads(request.content)
        assert payload == {'model': narration.MODEL, 'voice': 'cedar',
                           'input': 'Visit M87.', 'instructions': narration.INSTRUCTIONS,
                           'response_format': 'mp3'}
        return success(request)

    mock_api(monkeypatch, handler)
    with TestClient(app) as client:
        first = client.post('/api/narration/clip', json={'text': '  Visit M87.  '})
        assert first.status_code == 200
        clip = first.json()
        assert clip['cached'] is False
        assert clip['text'] == 'Visit M87.'
        assert len(clip['cache_key']) == 64
        audio = narration.ROOT / (clip['cache_key'] + '.mp3')
        assert audio.read_bytes() == MP3
        metadata = narration.ROOT / (clip['cache_key'] + '.json')
        saved = json.loads(metadata.read_text(encoding='utf-8'))
        assert saved['sha256'] == hashlib.sha256(MP3).hexdigest()
        assert saved['bytes'] == len(MP3)
        assert saved['ai_generated'] is True
        assert saved['request_id'] == 'req_test-123'
        assert saved['instructions'] == narration.INSTRUCTIONS
        assert FAKE_KEY not in metadata.read_text(encoding='utf-8')
        monkeypatch.setattr(narration.cloud_ai, 'get_key', lambda: '')
        replay = client.post('/api/narration/clip', json={'text': 'Visit M87.'}).json()
        assert replay == {**clip, 'cached': True}
        assert client.get(clip['url']).content == MP3
        assert client.get('/api/narration/status').json()['configured'] is False
    assert len(calls) == 1
    assert len(list(narration.ROOT.iterdir())) == 2


def test_audio_supports_browser_byte_range_requests(app, monkeypatch):
    mock_api(monkeypatch, success)
    with TestClient(app) as client:
        clip = client.post('/api/narration/clip', json={'text': 'M87'}).json()
        response = client.get(clip['url'], headers={'Range': 'bytes=4-12'})
    assert response.status_code == 206
    assert response.content == MP3[4:13]
    assert response.headers['Content-Range'] == f'bytes 4-12/{len(MP3)}'
    assert response.headers['Content-Type'] == 'audio/mpeg'
    assert response.headers['Accept-Ranges'] == 'bytes'


@pytest.mark.parametrize('body', [
    {}, {'text': ''}, {'text': ' \n\t '}, {'text': 'x' * 3501}, {'text': 1},
    {'text': None}, {'text': ['text']}, {'text': 'ok', 'voice': 'unknown'},
    {'text': 'ok', 'voice': None}, {'text': 'ok', 'model': 'other'},
    {'text': 'ok', 'instructions': 'override'}, {'text': 'ok', 'api_key': 'secret'},
])
def test_invalid_and_unknown_request_fields_are_rejected_before_network(app, body):
    with TestClient(app) as client:
        response = client.post('/api/narration/clip', json=body)
    assert response.status_code == 422
    assert not narration.ROOT.exists()


def test_max_length_text_and_all_supported_voices_are_accepted(app, monkeypatch):
    mock_api(monkeypatch, success)
    with TestClient(app) as client:
        for voice in narration.VOICES:
            response = client.post('/api/narration/clip', json={'text': 'x' * 3500, 'voice': voice})
            assert response.status_code == 200
            assert response.json()['voice'] == voice


def test_cache_identity_changes_with_model_voice_text_or_instructions():
    one = narration.ClipRequest(text='M87')
    assert narration.cache_key(one) == narration.cache_key(narration.ClipRequest(text=' M87 '))
    assert narration.cache_key(one) != narration.cache_key(narration.ClipRequest(text='M86'))
    assert narration.cache_key(one) != narration.cache_key(narration.ClipRequest(text='M87', voice='marin'))
    original = narration.cache_key(one)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(narration, 'MODEL', 'different-model')
        assert narration.cache_key(one) != original
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(narration, 'INSTRUCTIONS', 'Different narration style.')
        assert narration.cache_key(one) != original


@pytest.mark.parametrize('key', ['not-a-key', 'a' * 63, 'a' * 65, 'G' * 64, 'a' * 64])
def test_invalid_or_absent_audio_returns_404(app, key):
    with TestClient(app) as client:
        assert client.get(f'/api/narration/audio/{key}.mp3').status_code == 404


def test_audio_path_cannot_escape_cache(app):
    for key in ['../outside', '../' + 'a' * 64, '\\outside', 'a' * 64 + '/extra']:
        with pytest.raises(narration.HTTPException) as error:
            narration.paths(key)
        assert error.value.status_code == 404


def test_missing_or_unreadable_key_is_a_sanitized_conflict(app, monkeypatch):
    monkeypatch.setattr(narration.cloud_ai, 'get_key', lambda: '')
    with TestClient(app) as client:
        response = client.post('/api/narration/clip', json={'text': 'M87'})
        assert response.status_code == 409

        def unreadable():
            raise narration.cloud_ai.CloudError('Sensitive detail ' + FAKE_KEY)

        monkeypatch.setattr(narration.cloud_ai, 'get_key', unreadable)
        response = client.post('/api/narration/clip', json={'text': 'M87'})
        assert response.status_code == 409
        assert FAKE_KEY not in response.text
        status = client.get('/api/narration/status')
        assert status.json()['configured'] is False
        assert FAKE_KEY not in status.text


@pytest.mark.parametrize('remote_status,local_status', [(401, 401), (403, 403), (404, 403),
                                                      (429, 429), (500, 502), (302, 502)])
def test_api_errors_are_sanitized_and_not_retried(app, monkeypatch, remote_status, local_status):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(remote_status, json={'error': {'message': FAKE_KEY}})

    mock_api(monkeypatch, handler)
    with TestClient(app) as client:
        response = client.post('/api/narration/clip', json={'text': 'M87'})
    assert response.status_code == local_status
    assert FAKE_KEY not in response.text
    assert len(calls) == 1
    assert not narration.ROOT.exists()


def test_network_failure_is_sanitized_without_retry(app, monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout(FAKE_KEY, request=request)

    mock_api(monkeypatch, handler)
    with TestClient(app) as client:
        response = client.post('/api/narration/clip', json={'text': 'M87'})
    assert response.status_code == 504
    assert FAKE_KEY not in response.text
    assert 'may have been processed' in response.json()['detail']
    assert len(calls) == 1


@pytest.mark.parametrize('content,media_type', [(b'', 'audio/mpeg'), (b'not-mp3', 'audio/mpeg'),
                                             (MP3, 'application/json')])
def test_unusable_success_responses_are_not_cached(app, monkeypatch, content, media_type):
    mock_api(monkeypatch, lambda request: httpx.Response(200, content=content,
                                                        headers={'Content-Type': media_type}))
    with TestClient(app) as client:
        response = client.post('/api/narration/clip', json={'text': 'M87'})
    assert response.status_code == 502
    assert not narration.ROOT.exists()


def test_audio_size_is_bounded_even_without_content_length(app, monkeypatch):
    monkeypatch.setattr(narration, 'MAX_AUDIO_BYTES', 20)

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield MP3[:15]
            yield MP3[15:]

    mock_api(monkeypatch, lambda request: httpx.Response(200, stream=Stream(),
                                                        headers={'Content-Type': 'audio/mpeg'}))
    with TestClient(app) as client:
        response = client.post('/api/narration/clip', json={'text': 'M87'})
    assert response.status_code == 502
    assert 'size limit' in response.json()['detail']
    assert not narration.ROOT.exists()


@pytest.mark.parametrize('remote_status', [200, 429])
def test_concurrent_identical_clips_share_one_api_request_even_on_failure(app, monkeypatch, remote_status):
    calls = []

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()

        async def handler(request):
            calls.append(request)
            entered.set()
            await release.wait()
            return success(request) if remote_status == 200 else httpx.Response(429)

        mock_api(monkeypatch, handler)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            first = asyncio.create_task(client.post('/api/narration/clip', json={'text': 'M87'}))
            await entered.wait()
            second = asyncio.create_task(client.post('/api/narration/clip', json={'text': 'M87'}))
            await asyncio.sleep(0)
            release.set()
            responses = await asyncio.gather(first, second)
            assert all(response.status_code == remote_status for response in responses)
            if remote_status == 200:
                assert responses[0].json()['cache_key'] == responses[1].json()['cache_key']
        await asyncio.sleep(0)
        assert not narration._inflight

    asyncio.run(run())
    assert len(calls) == 1


def test_cancelled_caller_does_not_cancel_paid_generation_or_cause_duplicate_request(app, monkeypatch):
    calls = []

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()

        async def handler(request):
            calls.append(request)
            entered.set()
            await release.wait()
            return success(request)

        mock_api(monkeypatch, handler)
        request = narration.ClipRequest(text='M87')
        first = asyncio.create_task(narration.clip(request))
        await entered.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert len(narration._inflight) == 1
        second = asyncio.create_task(narration.clip(request))
        await asyncio.sleep(0)
        release.set()
        result = await second
        assert result['text'] == 'M87'
        monkeypatch.setattr(narration.cloud_ai, 'get_key', lambda: '')
        assert (await narration.clip(request))['cached'] is True

    asyncio.run(run())
    assert len(calls) == 1
