"""Local image-to-3D API tests. TRELLIS inference never runs in this suite."""
import hashlib
import io
import json
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from astropy.io import fits
from fastapi.testclient import TestClient
from PIL import Image

import astro_scene
import image_3d
import science
from app import app


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(science, 'IMAGES', tmp_path / 'images')
    science.IMAGES.mkdir()
    monkeypatch.setattr(image_3d, 'STORE', tmp_path / 'scenes')
    monkeypatch.setattr(image_3d, 'RUNTIME', tmp_path / 'runtime.json')
    monkeypatch.setattr(image_3d, 'ACTIVE', {})
    pools = {name: ThreadPoolExecutor(max_workers=1) for name in ('astronomy', 'trellis')}
    monkeypatch.setattr(image_3d, 'POOLS', pools)

    def no_inference(*args, **kwargs):
        raise AssertionError('These tests must not launch TRELLIS or a subprocess.')

    monkeypatch.setattr(image_3d.subprocess, 'Popen', no_inference)
    yield
    # Join all workers before monkeypatch restores paths and tmp_path is removed.
    for pool in pools.values():
        pool.shutdown(wait=True, cancel_futures=False)


@pytest.fixture
def client():
    with TestClient(app) as connection:
        yield connection


def imported(color=(30, 80, 140), size=(64, 48), name='field.png'):
    stream = io.BytesIO()
    Image.new('RGB', size, color).save(stream, format='PNG')
    original = stream.getvalue()
    metadata = science.import_image(original, name, source='CDS / source observatory',
                                    extra={'ra': 83.8, 'dec': -5.4, 'survey': 'DSS2'})
    return metadata, original


def wait_job(client, job_id, state=None):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get('/api/image-3d/jobs/' + job_id)
        assert response.status_code == 200
        job = response.json()
        if job['state'] == state or (state is None and job['state'] in ('complete', 'failed', 'cancelled')):
            return job
        threading.Event().wait(.015)
    pytest.fail('Local 3D job did not reach the expected state: ' + repr(job))


def wait_idle():
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with image_3d.LOCK:
            if not image_3d.ACTIVE:
                return
        threading.Event().wait(.015)
    pytest.fail('3D workers did not finish before cleanup.')


def runtime(ready=True):
    config = {'schema': 1, 'distribution': 'Ubuntu-22.04',
              'python': '/opt/local/python', 'worker': '/opt/local/worker.py',
              'repository': '/opt/local/TRELLIS.2', 'ready': ready,
              'message': 'Local test runtime ready' if ready else 'Model access is required.',
              'model': 'microsoft/TRELLIS.2-4B', 'resolutions': [512, 1024]}
    image_3d.RUNTIME.write_text(json.dumps(config), encoding='utf-8')
    return config


def test_real_scene_job_exports_glb_manifest_and_persists_original(client):
    metadata, original = imported()
    saved_metadata = science.meta_path(metadata['id']).read_bytes()
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'depth': .6, 'seed': 42})
    assert response.status_code == 200
    job_id = response.json()['id']
    job = wait_job(client, job_id)
    assert job['state'] == 'complete', job
    asset = job['result']
    assert asset['settings']['depth'] == .6 and asset['settings']['seed'] == 42
    assert asset['processing']['local'] is True and asset['processing']['ai_generated'] is False
    assert asset['scientific_evidence'] is False
    assert asset['source']['variant'] == 'original'
    assert asset['source']['sha256'] == hashlib.sha256(original).hexdigest()
    assert asset['source']['original_sha256'] == metadata['sha256']
    assert asset['source']['attribution'] == 'CDS / source observatory'
    assert asset['source']['context'] == metadata['extra']
    model = client.get(asset['model_url'])
    assert model.status_code == 200 and model.headers['content-type'] == 'model/gltf-binary'
    assert struct.unpack_from('<4sII', model.content) == (b'glTF', 2, len(model.content))
    assert asset['model_sha256'] == hashlib.sha256(model.content).hexdigest()
    assert asset['model_bytes'] == len(model.content)
    manifest = client.get(asset['manifest_url'])
    assert manifest.status_code == 200 and manifest.json() == asset
    assert 'attachment' in model.headers['content-disposition']
    wait_idle()
    # Read from persisted files once no in-memory worker state remains.
    assert image_3d.get_job(job_id)['result'] == asset
    assert client.get('/api/image-3d/images/' + metadata['id']).json() == {'rows': [asset]}
    assert (science.IMAGES / metadata['original_file']).read_bytes() == original
    assert science.meta_path(metadata['id']).read_bytes() == saved_metadata
    assert client.post('/api/image-3d/jobs/' + job_id + '/cancel').json()['state'] == 'complete'


@pytest.mark.parametrize('stretch', ['asinh', 'linear', 'log'])
def test_fits_uses_selected_stretch_without_altering_scientific_data(tmp_path, stretch):
    arr = np.arange(48 * 64, dtype=np.float32).reshape(48, 64) ** 1.2
    arr[0, 0] = np.nan
    stream = io.BytesIO()
    fits.PrimaryHDU(arr).writeto(stream)
    original = stream.getvalue()
    metadata = science.import_image(original, 'nebula.fits')
    original_array = (science.IMAGES / (metadata['id'] + '.npy')).read_bytes()
    destination = tmp_path / 'input.png'
    _, source = image_3d.source_input(image_3d.CreateJob(image_id=metadata['id'], stretch=stretch), destination)
    with Image.open(destination) as image:
        pixels = np.array(image)
    expected = np.flipud(science.stretch_array(arr, stretch))
    assert np.array_equal(pixels[:, :, 0], expected)
    assert np.array_equal(pixels[:, :, 0], pixels[:, :, 1])
    assert source['display_stretch'] == stretch and source['variant'] == 'fits-display-' + stretch
    assert source['original_sha256'] == hashlib.sha256(original).hexdigest()
    assert (science.IMAGES / metadata['original_file']).read_bytes() == original
    assert (science.IMAGES / (metadata['id'] + '.npy')).read_bytes() == original_array


def test_latest_saved_cloud_variant_is_used_with_source_provenance(client):
    metadata, original = imported()
    image_id, variant = metadata['id'], 'b' * 32
    Image.new('RGB', (88, 66), (204, 81, 22)).save(science.IMAGES / f'{image_id}-cloud-{variant}.png')
    Image.new('RGB', (64, 48), (1, 255, 1)).save(science.IMAGES / f'{image_id}-ai.png')
    metadata['ai'] = {'model': 'Older local enhancement'}
    metadata['cloud_ai'] = {'variant': variant, 'model': 'Bloom 2', 'provider': 'Topaz cloud'}
    science.save_metadata(metadata)
    response = client.post('/api/image-3d/jobs', json={'image_id': image_id, 'source': 'enhanced'})
    assert response.status_code == 200
    job = wait_job(client, response.json()['id'])
    assert job['state'] == 'complete', job
    source = job['result']['source']
    assert source['variant'] == 'cloud-' + variant
    assert source['provider'] == metadata['cloud_ai']
    assert source['original_sha256'] == hashlib.sha256(original).hexdigest()
    assert source['sha256'] == image_3d.sha(science.IMAGES / f'{image_id}-cloud-{variant}.png')
    with Image.open(image_3d.folder(job['id']) / 'input.png') as image:
        assert image.size == (88, 66) and image.getpixel((0, 0)) == (204, 81, 22)
    assert (science.IMAGES / metadata['original_file']).read_bytes() == original


@pytest.mark.parametrize('enhanced', [None, {'variant': 'bad-id'}, {'variant': 'a' * 32}])
def test_missing_enhanced_source_rejected_without_original_fallback(client, enhanced):
    metadata, _ = imported()
    if enhanced:
        metadata['cloud_ai'] = enhanced
        # A stale local file must not quietly replace the selected cloud result.
        metadata['ai'] = {'model': 'Old local result'}
        Image.new('RGB', (24, 24), 'green').save(science.IMAGES / (metadata['id'] + '-ai.png'))
        science.save_metadata(metadata)
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'source': 'enhanced'})
    assert response.status_code == 400
    assert not image_3d.ACTIVE
    assert not list((image_3d.STORE / 'assets').glob('*'))
    assert not list((image_3d.STORE / 'jobs').glob('*'))


def test_local_enhanced_source_is_available_without_cloud_variant(tmp_path):
    metadata, _ = imported()
    metadata['ai'] = {'model': 'FSRCNN x2'}
    science.save_metadata(metadata)
    path = science.IMAGES / (metadata['id'] + '-ai.png')
    Image.new('RGB', (128, 96), 'green').save(path)
    _, source = image_3d.source_input(image_3d.CreateJob(image_id=metadata['id'], source='enhanced'), tmp_path / 'input.png')
    assert source['variant'] == 'local-ai' and source['provider']['model'] == 'FSRCNN x2'
    assert source['sha256'] == image_3d.sha(path)


def test_source_jpeg_exif_orientation_is_applied_before_metadata_is_removed(tmp_path):
    stream = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6
    Image.new('RGB', (80, 40), 'red').save(stream, format='JPEG', exif=exif)
    metadata = science.import_image(stream.getvalue(), 'rotated.jpg')
    destination = tmp_path / 'input.png'
    _, source = image_3d.source_input(image_3d.CreateJob(image_id=metadata['id']), destination)
    assert source['original_size'] == [40, 80]
    with Image.open(destination) as image:
        assert image.size == (40, 80)


def test_trellis_not_ready_returns_409_before_creating_job(client):
    metadata, _ = imported()
    info = client.get('/api/image-3d/status').json()
    assert info['local_scene']['ready'] is True and info['trellis']['ready'] is False
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'mode': 'trellis'})
    assert response.status_code == 409 and not image_3d.STORE.exists()
    runtime(False)
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'mode': 'trellis'})
    assert response.status_code == 409 and 'Model access' in response.json()['detail']
    runtime(True)
    info = client.get('/api/image-3d/status').json()
    assert info['trellis']['ready'] is True and info['trellis']['resolutions'] == [512, 1024]
    assert '/opt/local' not in json.dumps(info)


@pytest.mark.parametrize('invalid', [[], 'invalid', 42, None, {'schema': 2}, {'schema': 1}])
def test_malformed_runtime_config_reports_setup_not_ready(client, invalid):
    image_3d.RUNTIME.write_text(json.dumps(invalid), encoding='utf-8')
    response = client.get('/api/image-3d/status')
    assert response.status_code == 200 and response.json()['trellis']['ready'] is False


@pytest.mark.parametrize('body', [
    {'image_id': '../bad'}, {'image_id': 'a' * 32, 'mode': 'cloud'},
    {'image_id': 'a' * 32, 'depth': 1.1}, {'image_id': 'a' * 32, 'seed': -1},
    {'image_id': 'a' * 32, 'resolution': 2048}, {'image_id': 'a' * 32, 'source': '../original'},
])
def test_invalid_job_requests_rejected(client, body):
    assert client.post('/api/image-3d/jobs', json=body).status_code == 422
    assert not image_3d.STORE.exists()


def test_identifier_and_asset_routes_do_not_expose_input_or_partial_output(client):
    for suffix, code in [('jobs/not-an-id', 400), ('jobs/' + 'a' * 32, 404),
                         ('images/not-an-id', 400), ('assets/not-an-id/model.glb', 400),
                         ('assets/' + 'a' * 32 + '/model.glb', 404),
                         ('assets/' + 'a' * 32 + '/input.png', 404),
                         ('assets/' + 'a' * 32 + '/cancel.flag', 404)]:
        assert client.get('/api/image-3d/' + suffix).status_code == code
    target = image_3d.folder('a' * 32)
    target.mkdir(parents=True)
    (target / 'model.glb').write_bytes(b'partial')
    assert client.get('/api/image-3d/assets/' + 'a' * 32 + '/model.glb').status_code == 404


def test_queue_deduplication_limit_and_cancellation_win_over_completed_worker(client, monkeypatch):
    metadata, _ = imported()
    entered, release = threading.Event(), threading.Event()
    original_generator = astro_scene.generate_scene
    calls = []

    def held_generator(*args, **kwargs):
        calls.append(kwargs)
        entered.set()
        if not release.wait(8):
            raise RuntimeError('Test worker was not released.')
        return original_generator(*args, **kwargs)

    monkeypatch.setattr(astro_scene, 'generate_scene', held_generator)
    monkeypatch.setattr(image_3d, 'MAX_JOBS', 2)
    body = {'image_id': metadata['id'], 'seed': 1}
    try:
        first = client.post('/api/image-3d/jobs', json=body).json()
        assert entered.wait(3)
        duplicate = client.post('/api/image-3d/jobs', json=body)
        assert duplicate.status_code == 200 and duplicate.json()['id'] == first['id']
        second = client.post('/api/image-3d/jobs', json={**body, 'seed': 2}).json()
        assert second['id'] != first['id'] and second['state'] == 'queued'
        assert client.post('/api/image-3d/jobs', json={**body, 'seed': 3}).status_code == 429
        for job in (first, second):
            cancelled = client.post('/api/image-3d/jobs/' + job['id'] + '/cancel')
            assert cancelled.status_code == 200 and cancelled.json()['state'] == 'cancelled'
            assert (image_3d.folder(job['id']) / 'cancel.flag').exists()
        release.set()
        wait_idle()
        assert len(calls) == 1  # The cancelled queued job never generates a scene.
        for job in (first, second):
            assert wait_job(client, job['id'])['state'] == 'cancelled'
            assert not (image_3d.folder(job['id']) / 'manifest.json').exists()
            assert client.get('/api/image-3d/assets/' + job['id'] + '/model.glb').status_code == 404
        assert client.get('/api/image-3d/images/' + metadata['id']).json() == {'rows': []}
    finally:
        release.set()


def test_mock_trellis_subprocess_uses_arguments_and_exports_validated_result(client, monkeypatch, tmp_path):
    metadata, _ = imported()
    runtime(True)
    sample = tmp_path / 'sample'
    astro_scene.generate_scene(science.IMAGES / metadata['original_file'], sample)
    sample_glb = (sample / 'scene.glb').read_bytes()
    commands = []

    class FakeProcess:
        def __init__(self, command, **options):
            commands.append((command, options))
            job_id = next(iter(image_3d.ACTIVE))
            (image_3d.folder(job_id) / 'model.glb').write_bytes(sample_glb)
            self.stdout = io.StringIO('{"progress":"Mesh generation"}\n')
            self.returncode = None
            self.calls = 0

        def poll(self):
            self.calls += 1
            if self.calls >= 3:
                self.returncode = 0
            return self.returncode

    monkeypatch.setattr(image_3d.subprocess, 'Popen', FakeProcess)
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'mode': 'trellis', 'resolution': 1024, 'seed': 123})
    assert response.status_code == 200
    job = wait_job(client, response.json()['id'])
    assert job['state'] == 'complete', job
    command, options = commands[0]
    assert command[:6] == ['wsl.exe', '-d', 'Ubuntu-22.04', '--', '/opt/local/python', '/opt/local/worker.py']
    assert command[command.index('--seed') + 1] == '123'
    assert command[command.index('--resolution') + 1] == '1024'
    assert command[command.index('--cancel-file') + 1].endswith('/cancel.flag')
    assert command[command.index('--heartbeat-file') + 1].endswith('/worker.heartbeat')
    assert (image_3d.folder(job['id']) / 'worker.heartbeat').is_file()
    assert not options.get('shell')
    assert job['result']['processing']['local'] is True
    assert job['result']['processing']['ai_generated'] is True
    assert job['result']['processing']['scientific'] is False
    assert client.get(job['result']['model_url']).content == sample_glb


def test_subprocess_failure_is_terminal_without_publishing_an_asset(client, monkeypatch):
    metadata, _ = imported()
    runtime(True)

    class FailedProcess:
        returncode = 1

        def __init__(self, *args, **kwargs):
            self.stdout = io.StringIO('private model cache diagnostic\n')

        def poll(self):
            return self.returncode

    monkeypatch.setattr(image_3d.subprocess, 'Popen', FailedProcess)
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'mode': 'trellis'})
    job = wait_job(client, response.json()['id'])
    assert job['state'] == 'failed' and 'TRELLIS could not finish' in job['error']
    assert 'private model cache' not in json.dumps(job)
    wait_idle()
    assert not (image_3d.folder(job['id']) / 'manifest.json').exists()


@pytest.mark.parametrize('error,hint', [
    ('Gated DINOv3 model; awaiting a review and approved access.', 'approved DINOv3 access'),
    ('CUDA out of memory.', 'out of GPU memory'),
])
def test_long_json_failure_event_is_drained_after_process_exit_and_sanitized(client, monkeypatch, error, hint):
    metadata, _ = imported()
    runtime(True)
    diagnostic = 'private diagnostic context; ' * 48 + error
    line = json.dumps({'progress': 'TRELLIS.2 could not finish', 'error': diagnostic}) + '\n'
    assert len(line) > 1000

    class DelayedOutput:
        closed = False
        sent = False

        def __iter__(self):
            return self

        def __next__(self):
            if self.sent:
                raise StopIteration
            self.sent = True
            # The process has already exited before its buffered final line is
            # drained by the reader thread. The parent must join and consume it.
            threading.Event().wait(.025)
            return line

        def close(self):
            self.closed = True

    class FinishedProcess:
        returncode = 1

        def __init__(self, *args, **kwargs):
            self.stdout = DelayedOutput()

        def poll(self):
            return self.returncode

    monkeypatch.setattr(image_3d.subprocess, 'Popen', FinishedProcess)
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'mode': 'trellis'})
    job = wait_job(client, response.json()['id'])
    assert job['state'] == 'failed' and hint in job['error']
    assert 'private diagnostic' not in json.dumps(job)
    wait_idle()


def test_graceful_app_shutdown_cancels_running_and_queued_jobs(monkeypatch):
    metadata, _ = imported()
    entered, release = threading.Event(), threading.Event()
    original_generator = astro_scene.generate_scene

    def held_generator(*args, **kwargs):
        entered.set()
        if not release.wait(8):
            raise RuntimeError('Test worker was not released.')
        return original_generator(*args, **kwargs)

    monkeypatch.setattr(astro_scene, 'generate_scene', held_generator)
    try:
        with TestClient(app) as connection:
            first = connection.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'seed': 1}).json()
            assert entered.wait(3)
            second = connection.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'seed': 2}).json()
            assert first['id'] != second['id'] and second['state'] == 'queued'
        # Exiting the lifespan writes cancellation markers before executor exit.
        for job in (first, second):
            assert image_3d.read_job(job['id'])['state'] == 'cancelled'
            assert (image_3d.folder(job['id']) / 'cancel.flag').is_file()
        release.set()
        wait_idle()
        assert all(not (image_3d.folder(job['id']) / 'manifest.json').exists() for job in (first, second))
    finally:
        release.set()


@pytest.mark.parametrize('cancel,cooperative', [(True, True), (True, False), (False, True)])
def test_running_trellis_cancellation_and_timeout_stop_subprocess(client, monkeypatch, cancel, cooperative):
    metadata, _ = imported()
    runtime(True)
    entered = threading.Event()
    stopped = []

    class HeldProcess:
        returncode = None

        def __init__(self, *args, **kwargs):
            self.stdout = io.StringIO('')
            entered.set()

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            job_id = next(iter(image_3d.ACTIVE))
            assert (image_3d.folder(job_id) / 'cancel.flag').exists()
            stopped.append(('wait', timeout))
            if not cooperative and self.returncode is None:
                raise image_3d.subprocess.TimeoutExpired('test worker', timeout)
            self.returncode = 130 if self.returncode is None else self.returncode
            return self.returncode

        def terminate(self):
            stopped.append(('terminate', None))
            self.returncode = -15

    monkeypatch.setattr(image_3d.subprocess, 'Popen', HeldProcess)
    if not cancel:
        monkeypatch.setattr(image_3d, 'TIMEOUT', 0)
    response = client.post('/api/image-3d/jobs', json={'image_id': metadata['id'], 'mode': 'trellis'})
    assert response.status_code == 200 and entered.wait(3)
    job_id = response.json()['id']
    if cancel:
        assert client.post('/api/image-3d/jobs/' + job_id + '/cancel').json()['state'] == 'cancelled'
    wait_idle()
    job = wait_job(client, job_id)
    assert job['state'] == ('cancelled' if cancel else 'failed')
    assert stopped and stopped[0][0] == 'wait'
    assert (('terminate', None) in stopped) is (not cooperative)
    if not cancel:
        assert 'exceeded' in job['error']
    assert not (image_3d.folder(job_id) / 'manifest.json').exists()


def test_restart_recovers_interrupted_jobs_and_preserves_finished_records():
    for index, state in enumerate(('queued', 'running', 'complete', 'cancelled')):
        job_id = str(index) * 32
        image_3d.folder(job_id).mkdir(parents=True)
        image_3d.write_json(image_3d.job_path(job_id), {'id': job_id, 'state': state})
    image_3d.recover_interrupted()
    for index in (0, 1):
        job = image_3d.read_job(str(index) * 32)
        assert job['state'] == 'failed' and 'stopped' in job['error']
        assert (image_3d.folder(job['id']) / 'cancel.flag').exists()
    assert image_3d.read_job('2' * 32)['state'] == 'complete'
    assert image_3d.read_job('3' * 32)['state'] == 'cancelled'


def test_glb_validator_rejects_external_assets_and_empty_geometry(tmp_path):
    path = tmp_path / 'bad.glb'
    path.write_bytes(b'invalid')
    with pytest.raises(ValueError, match='empty'):
        image_3d.validate_glb(path)
    for document, expected in [({'meshes': [{}], 'images': [{'uri': 'https://elsewhere/texture.png'}]}, 'embed'),
                               ({'meshes': [{}], 'buffers': [{'uri': 'external.bin'}]}, 'embed'),
                               ({'meshes': []}, 'no geometry')]:
        encoded = json.dumps(document).encode()
        encoded += b' ' * (-len(encoded) % 4)
        path.write_bytes(struct.pack('<4sIIII', b'glTF', 2, 20 + len(encoded), len(encoded), 0x4E4F534A) + encoded)
        with pytest.raises(ValueError, match=expected):
            image_3d.validate_glb(path)
