"""Topaz requests are mocked; these tests never submit paid API jobs."""
import asyncio
import hashlib
import io
import json

import httpx
import numpy as np
from astropy.io import fits
from fastapi.testclient import TestClient
from PIL import Image
import pytest

import science
import topaz_ai

FAKE_KEY = 'test-topaz-secret-not-a-real-api-key'
JOB_ID = '641ac8f1-e6f8-4d97-85c0-e92559a4d21f'
RESULT_URL = 'https://results.s3.amazonaws.com/fixture.png?signature=private'


def png(size=(24, 18), color=(44, 83, 101)):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, format='PNG')
    return buffer.getvalue()


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(science, 'IMAGES', tmp_path / 'images')
    science.IMAGES.mkdir()
    monkeypatch.setattr(topaz_ai, 'KEY_FILE', tmp_path / 'topaz-key.dpapi')
    monkeypatch.setattr(topaz_ai, 'SESSION_KEY', FAKE_KEY)
    monkeypatch.setattr(topaz_ai, 'BALANCE', None)
    monkeypatch.setattr(topaz_ai, 'POLL_SECONDS', 0)
    monkeypatch.delenv('TOPAZ_API_KEY', raising=False)

    def forbid_network():
        raise AssertionError('Tests must use a mock transport; no paid network access.')

    monkeypatch.setattr(topaz_ai, 'make_client', forbid_network)


def mock_api(monkeypatch, handler):
    monkeypatch.setattr(topaz_ai, 'make_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def run(coroutine):
    return asyncio.run(coroutine)


def image_fixture(size=(24, 18)):
    content = png(size)
    return science.import_image(content, 'nebula.png'), content


def happy_api(calls, output_size=(48, 36), states=None, url=RESULT_URL):
    statuses = list(states or ['Completed'])

    def handler(request):
        calls.append(request)
        if request.url.host == 'api.topazlabs.com':
            assert request.headers['X-API-Key'] == FAKE_KEY
        else:
            assert 'X-API-Key' not in request.headers
            assert 'Authorization' not in request.headers
        if request.method == 'POST':
            return httpx.Response(200, json={'process_id': JOB_ID})
        if '/status/' in request.url.path:
            state = statuses.pop(0) if len(statuses) > 1 else statuses[0]
            return httpx.Response(200, json={'status': state})
        if '/download/' in request.url.path:
            return httpx.Response(200, json={'download_url': url})
        assert str(request.url) == RESULT_URL
        return httpx.Response(200, content=png(output_size), headers={'Content-Type': 'image/png'})

    return handler


def test_connect_uses_only_readonly_credit_validation_and_redacts_key(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == 'GET' and str(request.url) == topaz_ai.BALANCE_URL
        assert request.headers['X-API-Key'] == FAKE_KEY
        return httpx.Response(200, json={'available_credits': 12, 'reserved_credits': 2, 'total_credits': 14})

    mock_api(monkeypatch, handler)
    result = run(topaz_ai.connect(FAKE_KEY))
    assert result['configured'] is True and result['available_credits'] == 12
    assert result['storage'] == 'session'
    assert FAKE_KEY not in json.dumps(result)
    assert len(calls) == 1 and not topaz_ai.KEY_FILE.exists()


def test_failed_validation_does_not_save_or_echo_key(monkeypatch):
    monkeypatch.setattr(topaz_ai, 'SESSION_KEY', None)
    mock_api(monkeypatch, lambda request: httpx.Response(401, json={'message': FAKE_KEY}))
    with pytest.raises(topaz_ai.TopazError) as failure:
        run(topaz_ai.connect(FAKE_KEY, remember=True))
    assert failure.value.status == 401
    assert FAKE_KEY not in str(failure.value)
    assert topaz_ai.SESSION_KEY is None and not topaz_ai.KEY_FILE.exists()


def test_remembered_key_is_encrypted_and_disconnect_removes_it(monkeypatch):
    mock_api(monkeypatch, lambda request: httpx.Response(200, json={'available_credits': 0}))
    monkeypatch.setattr(topaz_ai, 'protect', lambda data, decrypt=False: FAKE_KEY.encode() if decrypt else b'encrypted-ciphertext')
    assert run(topaz_ai.connect(FAKE_KEY, remember=True))['storage'] == 'Windows encrypted storage'
    assert topaz_ai.KEY_FILE.read_bytes() == b'encrypted-ciphertext'
    monkeypatch.setattr(topaz_ai, 'SESSION_KEY', None)
    assert topaz_ai.get_key() == FAKE_KEY
    assert topaz_ai.disconnect()['configured'] is False
    assert not topaz_ai.KEY_FILE.exists()


def test_prepare_reads_full_original_not_the_thumbnail():
    metadata, _ = image_fixture((1800, 30))
    assert metadata['preview_width'] == 1600
    _, content, size, source = topaz_ai.prepare(metadata['id'], 2)
    assert size == [1800, 30]
    with Image.open(io.BytesIO(content)) as image:
        assert image.size == (1800, 30)
    assert 'original' in source


def test_fits_prepare_uses_full_selected_display_raster():
    array = np.arange(1800 * 12, dtype=np.float32).reshape(12, 1800)
    buffer = io.BytesIO()
    fits.PrimaryHDU(array).writeto(buffer)
    metadata = science.import_image(buffer.getvalue(), 'field.fits')
    _, content, size, source = topaz_ai.prepare(metadata['id'], 2, 'linear')
    with Image.open(io.BytesIO(content)) as image:
        actual = np.array(image)
    expected = np.flipud(science.stretch_array(array, 'linear'))
    assert size == [1800, 12] and actual.shape == (12, 1800, 3)
    assert np.array_equal(actual[:, :, 0], expected)
    assert 'linear' in source and 'not calibrated' in source


def test_oversized_upscale_rejects_before_any_paid_submission():
    metadata, _ = image_fixture((1300, 1300))
    with pytest.raises(topaz_ai.TopazError, match='25 million pixels'):
        run(topaz_ai.enhance(metadata['id'], 4))
    assert 'topaz_pending' not in science.metadata(metadata['id'])


def test_upscale_saves_separate_labeled_result_with_provenance(monkeypatch):
    metadata, original = image_fixture()
    calls = []
    mock_api(monkeypatch, happy_api(calls, states=['Pending', 'Processing', 'Completed']))
    result = run(topaz_ai.enhance(metadata['id'], 2))
    submissions = [request for request in calls if request.method == 'POST']
    assert len(submissions) == 1
    body = submissions[0].content
    assert b'Standard V2' in body and b'name="output_width"\r\n\r\n48' in body
    assert b'name="output_height"\r\n\r\n36' in body
    assert b'name="face_enhancement"\r\n\r\nfalse' in body
    assert str(submissions[0].url) == topaz_ai.BASE_URL + '/enhance/async'
    assert (science.IMAGES / metadata['original_file']).read_bytes() == original
    assert result['sha256'] == hashlib.sha256(original).hexdigest()
    variant = result['cloud_ai']
    assert variant['provider'] == 'Topaz cloud' and variant['model'] == 'Standard V2'
    assert variant['output_size'] == [48, 36] and variant['scale'] == 2
    assert variant['scientific_evidence'] is False
    assert variant['request_id'] == JOB_ID
    assert 'topaz_pending' not in result
    assert FAKE_KEY not in json.dumps(result)
    with Image.open(science.IMAGES / (metadata['id'] + '-cloud-' + variant['variant'] + '.png')) as image:
        provenance = json.loads(image.info['Provenance'])
        assert provenance['original_sha256'] == metadata['sha256']
        assert provenance['request_id'] == JOB_ID
        assert image.getpixel((0, image.height - 1)) == (0, 0, 0)


def test_saved_job_resumes_after_network_failure_without_second_paid_post(monkeypatch):
    metadata, _ = image_fixture()
    calls = []
    success = happy_api(calls)
    fail_status = True

    def handler(request):
        if '/status/' in request.url.path and fail_status:
            raise httpx.ReadTimeout('vendor echoed ' + FAKE_KEY, request=request)
        return success(request)

    mock_api(monkeypatch, handler)
    with pytest.raises(topaz_ai.TopazError) as failure:
        run(topaz_ai.enhance(metadata['id'], 2))
    assert failure.value.status == 504 and JOB_ID in str(failure.value)
    assert FAKE_KEY not in str(failure.value)
    assert science.metadata(metadata['id'])['topaz_pending']['process_id'] == JOB_ID
    fail_status = False
    result = run(topaz_ai.enhance(metadata['id'], 2))
    assert len([request for request in calls if request.method == 'POST']) == 1
    assert result['cloud_ai']['request_id'] == JOB_ID


def test_saved_job_rejects_different_scale(monkeypatch):
    metadata, _ = image_fixture()
    _, content, _, _ = topaz_ai.prepare(metadata['id'])
    metadata['topaz_pending'] = {'process_id': JOB_ID, 'scale': 2, 'input_sha256': hashlib.sha256(content).hexdigest()}
    science.save_metadata(metadata)
    with pytest.raises(topaz_ai.TopazError, match='original scale'):
        run(topaz_ai.enhance(metadata['id'], 4))


def test_terminal_failed_job_is_recorded_without_automatic_resubmission(monkeypatch):
    metadata, _ = image_fixture()
    calls = []
    mock_api(monkeypatch, happy_api(calls, states=['Failed']))
    with pytest.raises(topaz_ai.TopazError, match='failed'):
        run(topaz_ai.enhance(metadata['id']))
    saved = science.metadata(metadata['id'])
    assert 'topaz_pending' not in saved
    assert saved['topaz_last_job']['status'] == 'Failed'
    assert len([request for request in calls if request.method == 'POST']) == 1


@pytest.mark.parametrize('url', ['http://results.s3.amazonaws.com/file', 'https://127.0.0.1/file',
                               'https://amazonaws.com.attacker.invalid/file', 'https://user:password@results.s3.amazonaws.com/file'])
def test_unsafe_result_locations_are_not_fetched(monkeypatch, url):
    metadata, _ = image_fixture()
    calls = []
    mock_api(monkeypatch, happy_api(calls, url=url))
    with pytest.raises(topaz_ai.TopazError, match='unsupported result location'):
        run(topaz_ai.enhance(metadata['id']))
    assert len(calls) == 3
    assert all(request.url.host == 'api.topazlabs.com' for request in calls)
    assert science.metadata(metadata['id'])['topaz_pending']['process_id'] == JOB_ID


def test_unexpected_result_dimensions_do_not_modify_original(monkeypatch):
    metadata, original = image_fixture()
    calls = []
    mock_api(monkeypatch, happy_api(calls, output_size=(27, 22)))
    with pytest.raises(topaz_ai.TopazError, match='unexpected output dimensions'):
        run(topaz_ai.enhance(metadata['id']))
    assert not science.metadata(metadata['id']).get('cloud_history')
    assert (science.IMAGES / metadata['original_file']).read_bytes() == original


def test_api_rejects_invalid_scale_and_blocks_concurrent_cloud_edits(monkeypatch):
    import app as application
    metadata, _ = image_fixture()
    calls = []

    async def fake_enhance(image_id, scale, stretch, model, parameters):
        calls.append((image_id, scale, stretch, model, parameters))
        return {'id': image_id, 'scale': scale, 'stretch': stretch, 'model': model, 'parameters': parameters}

    monkeypatch.setattr(topaz_ai, 'enhance', fake_enhance)
    with TestClient(application.app) as client:
        path = '/api/images/' + metadata['id'] + '/enhance-topaz'
        assert client.post(path, json={'scale': 8}).status_code == 422
        result = client.post(path, json={'scale': 4, 'stretch': 'log'})
        assert result.status_code == 200 and result.json()['scale'] == 4
        monkeypatch.setattr(application.CLOUD_BUSY, 'locked', lambda: True)
        assert client.post(path, json={'scale': 2}).status_code == 409
    assert calls == [(metadata['id'], 4, 'log', topaz_ai.MODEL, {})]


def test_model_catalog_offers_current_creative_generative_and_precision_options():
    import app as application
    with TestClient(application.app) as client:
        response = client.get('/api/topaz/models')
    assert response.status_code == 200
    catalog = response.json()
    assert catalog['default_model'] == 'Standard V2'
    assert catalog['max_output_pixels'] == 25_000_000
    assert catalog['scales'] == [2, 4]
    models = {model['id']: model for model in catalog['models']}
    assert set(models) == {'Standard V2', 'High Fidelity V2', 'Upscale High Fidelity V3',
                           'Bloom 2', 'Wonder 3.5', 'Recover 3'}
    assert models['Bloom 2']['family'] == 'Creative'
    assert models['Wonder 3.5']['family'] == 'Generative'
    assert models['Upscale High Fidelity V3']['family'] == 'Precision'
    bloom = {setting['key']: setting for setting in models['Bloom 2']['parameters']}
    assert bloom['creativity']['max'] == 9 and bloom['colorPreservation']['default'] is True
    assert bloom['prompt']['max_length'] == 1024
    assert FAKE_KEY not in response.text


@pytest.mark.parametrize(('model', 'endpoint', 'parameters', 'expected'), [
    ('Standard V2', '/enhance/async', {'sharpen': None, 'denoise': .25}, {'denoise': .25}),
    ('High Fidelity V2', '/enhance/async', {'sharpen': 0}, {'sharpen': 0}),
    ('Upscale High Fidelity V3', '/enhance/async', {'recoveryStrength': .6, 'opacity': .8},
     {'recoveryStrength': .6, 'opacity': .8}),
    ('Bloom 2', '/enhance-gen/async', {'creativity': 6, 'colorPreservation': False, 'prompt': 'Luminous nebula'},
     {'creativity': 6, 'colorPreservation': False, 'prompt': 'Luminous nebula', 'grain': False}),
    ('Wonder 3.5', '/enhance-gen/async', {'enhancementStrength': 'low'},
     {'enhancementStrength': 'low', 'grain': False}),
    ('Recover 3', '/enhance-gen/async', {'enhancementStrength': 2.5, 'texture': 2},
     {'enhancementStrength': 2.5, 'texture': 2, 'creativity': 3, 'prompt': ''}),
])
def test_each_model_routes_validated_settings_and_records_actual_model(monkeypatch, model, endpoint, parameters, expected):
    metadata, original = image_fixture()
    calls = []
    mock_api(monkeypatch, happy_api(calls))
    result = run(topaz_ai.enhance(metadata['id'], 2, 'asinh', model, parameters))
    submission = next(request for request in calls if request.method == 'POST')
    assert str(submission.url) == topaz_ai.BASE_URL + endpoint
    for key, value in expected.items():
        text = ('true' if value else 'false') if isinstance(value, bool) else str(value)
        assert (f'name="{key}"\r\n\r\n{text}\r\n').encode() in submission.content
    assert b'None' not in submission.content
    assert result['cloud_ai']['model'] == model
    assert result['cloud_ai']['parameters'] == expected
    assert result['cloud_ai']['model_family'] == next(item['family'] for item in topaz_ai.MODELS if item['id'] == model)
    assert (science.IMAGES / metadata['original_file']).read_bytes() == original
    variant = result['cloud_ai']['variant']
    with Image.open(science.IMAGES / (metadata['id'] + '-cloud-' + variant + '.png')) as image:
        provenance = json.loads(image.info['Provenance'])
        options = json.loads(provenance['prompt'])
        assert provenance['model'] == model
        assert options['parameters'] == expected


@pytest.mark.parametrize(('model', 'parameters'), [
    ('Invented Model', {}),
    ('Standard V2', {'creativity': 3}),
    ('Standard V2', {'sharpen': float('nan')}),
    ('Standard V2', {'denoise': True}),
    ('Bloom 2', {'creativity': 10}),
    ('Bloom 2', {'creativity': 3.5}),
    ('Bloom 2', {'creativity': None}),
    ('Bloom 2', {'colorPreservation': 'true'}),
    ('Bloom 2', {'prompt': 'x' * 1025}),
    ('Wonder 3.5', {'enhancementStrength': 4}),
    ('Recover 3', {'enhancementStrength': 11}),
    ('Upscale High Fidelity V3', {'opacity': -.1}),
])
def test_invalid_or_cross_model_settings_never_reach_network(model, parameters):
    metadata, _ = image_fixture()
    with pytest.raises(topaz_ai.TopazError):
        run(topaz_ai.enhance(metadata['id'], 2, 'asinh', model, parameters))
    assert 'topaz_pending' not in science.metadata(metadata['id'])


def test_pending_job_identity_includes_model_and_all_options(monkeypatch):
    metadata, _ = image_fixture()
    calls = []
    completed = happy_api(calls)
    fail = True

    def handler(request):
        if fail and '/status/' in request.url.path:
            raise httpx.ReadTimeout('Timeout', request=request)
        return completed(request)

    mock_api(monkeypatch, handler)
    with pytest.raises(topaz_ai.TopazError):
        run(topaz_ai.enhance(metadata['id'], model='Bloom 2', parameters={'creativity': 4}))
    pending = science.metadata(metadata['id'])['topaz_pending']
    assert pending['model'] == 'Bloom 2' and pending['parameters']['creativity'] == 4
    for model, parameters in [('Wonder 3.5', {}), ('Bloom 2', {'creativity': 5}),
                               ('Bloom 2', {'creativity': 4, 'colorPreservation': False})]:
        with pytest.raises(topaz_ai.TopazError, match='original scale, model') as failure:
            run(topaz_ai.enhance(metadata['id'], model=model, parameters=parameters))
        assert failure.value.status == 409
    fail = False
    result = run(topaz_ai.enhance(metadata['id'], model='Bloom 2', parameters={'creativity': 4}))
    assert result['cloud_ai']['model'] == 'Bloom 2'
    assert len([request for request in calls if request.method == 'POST']) == 1


def test_legacy_standard_job_without_parameters_resumes_without_submission(monkeypatch):
    metadata, _ = image_fixture()
    _, content, size, source = topaz_ai.prepare(metadata['id'])
    metadata['topaz_pending'] = {'process_id': JOB_ID, 'scale': 2, 'model': 'Standard V2',
        'input_sha256': hashlib.sha256(content).hexdigest(), 'input_size': size,
        'output_size': [dimension * 2 for dimension in size], 'stretch': None, 'input_source': source}
    science.save_metadata(metadata)
    calls = []
    mock_api(monkeypatch, happy_api(calls))
    result = run(topaz_ai.enhance(metadata['id']))
    assert result['cloud_ai']['model'] == 'Standard V2'
    assert result['cloud_ai']['parameters'] == {}
    assert not any(request.method == 'POST' for request in calls)


def test_api_passes_selected_model_and_parameters_to_backend(monkeypatch):
    import app as application
    metadata, _ = image_fixture()
    calls = []

    async def capture(*args):
        calls.append(args)
        return {'id': args[0]}

    monkeypatch.setattr(topaz_ai, 'enhance', capture)
    with TestClient(application.app) as client:
        response = client.post('/api/images/' + metadata['id'] + '/enhance-topaz',
            json={'scale': 4, 'model': 'Bloom 2', 'parameters': {'creativity': 7, 'prompt': 'Bright stars'}})
    assert response.status_code == 200
    assert calls == [(metadata['id'], 4, 'asinh', 'Bloom 2', {'creativity': 7, 'prompt': 'Bright stars'})]
