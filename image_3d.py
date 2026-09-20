"""Local, cancellable image-to-3D jobs; originals are never modified."""
import atexit
import hashlib
import json
import os
import queue
import re
import struct
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

import astro_scene
import science

ROOT = Path(__file__).resolve().parent
STORE = ROOT / 'data' / 'image-3d'
RUNTIME = ROOT / 'data' / 'trellis-runtime.json'
router = APIRouter(prefix='/api/image-3d', tags=['Image 3D'])
LOCK = threading.RLock()
POOLS = {mode: ThreadPoolExecutor(max_workers=1, thread_name_prefix='image3d-' + mode)
         for mode in ('astronomy', 'trellis')}
ACTIVE = {}
TIMEOUT = 1800
MAX_JOBS = 4
TRELLIS_MODEL = 'microsoft/TRELLIS.2-4B'


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value):
    if not re.fullmatch('[0-9a-f]{32}', value):
        raise HTTPException(400, 'Invalid 3D identifier.')
    return value


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def job_path(job_id):
    return STORE / 'jobs' / (identifier(job_id) + '.json')


def folder(job_id):
    return STORE / 'assets' / identifier(job_id)


def read_job(job_id):
    path = job_path(job_id)
    with LOCK:
        if not path.is_file():
            raise HTTPException(404, '3D job not found.')
        return json.loads(path.read_text(encoding='utf-8'))


def update_job(job_id, **values):
    with LOCK:
        job = read_job(job_id)
        # Cancellation wins over a worker finishing at the same instant.
        if job['state'] == 'cancelled':
            return job
        job.update(values, updated_at=now())
        write_json(job_path(job_id), job)
        return job


def runtime_config():
    try:
        value = json.loads(RUNTIME.read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            return None
        if value.get('schema') != 1:
            return None
        if not re.fullmatch('[A-Za-z0-9_.-]{1,80}', value['distribution']):
            return None
        for name in ('python', 'worker', 'repository'):
            item = value[name]
            if not isinstance(item, str) or not item.startswith('/') or any(ord(c) < 32 for c in item):
                return None
        value['model'] = TRELLIS_MODEL
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return None


@router.get('/status')
def status():
    config = runtime_config()
    return {'local_scene': {'ready': True, 'label': 'Astronomy scene'}, 'trellis': {
        'ready': bool(config and config.get('ready') is True), 'label': 'TRELLIS.2',
        'message': (config or {}).get('message') or 'Local TRELLIS setup is required.',
        'verified_at': (config or {}).get('verified_at'),
        'resolutions': (config or {}).get('resolutions', [512, 1024]),
        'model': TRELLIS_MODEL}}


class CreateJob(BaseModel):
    image_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    mode: Literal['astronomy', 'trellis'] = 'astronomy'
    source: Literal['original', 'enhanced'] = 'original'
    depth: float = Field(default=.35, ge=0, le=1, allow_inf_nan=False)
    seed: int = Field(default=0, ge=0, le=2147483647)
    resolution: Literal[512, 1024] = 512
    stretch: Literal['asinh', 'linear', 'log'] = 'asinh'


def source_input(request, destination):
    metadata = science.metadata(request.image_id)
    variant, provider = 'original', None
    if request.source == 'enhanced':
        enhanced = metadata.get('cloud_ai')
        if enhanced:
            variant_id = enhanced.get('variant', '')
            if not re.fullmatch('[0-9a-f]{32}', variant_id):
                raise ValueError('The saved enhanced image has no valid variant.')
            path = science.IMAGES / f'{request.image_id}-cloud-{variant_id}.png'
            variant = 'cloud-' + variant_id
            provider = {key: enhanced[key] for key in ('provider', 'model', 'variant') if key in enhanced}
        elif metadata.get('ai'):
            path = science.IMAGES / (request.image_id + '-ai.png')
            variant, provider = 'local-ai', {'model': metadata['ai'].get('model')}
        else:
            raise ValueError('Create and save an enhanced image before using this source.')
    elif metadata.get('scientific'):
        path = science.render(request.image_id, request.stretch)
        variant = 'fits-display-' + request.stretch
    else:
        name = metadata.get('original_file', '')
        if not name or Path(name).name != name or not name.startswith(request.image_id):
            raise ValueError('The original image file is unavailable.')
        path = science.IMAGES / name
    if not path.is_file():
        raise ValueError('The selected source image is missing. Open or enhance the image again.')
    with Image.open(path) as image:
        if image.width * image.height > 25_000_000:
            raise ValueError('3D input is limited to 25 million pixels.')
        image = ImageOps.exif_transpose(image)
        original_size = list(image.size)
        # Composite transparent images against the same dark background as the lab.
        rgba = image.convert('RGBA')
        display = Image.new('RGBA', rgba.size, (0, 0, 0, 255))
        display.alpha_composite(rgba)
        display = display.convert('RGB')
        display.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        display.save(destination)
    return metadata, {'image_id': request.image_id, 'variant': variant, 'provider': provider,
                      'sha256': sha(path), 'original_sha256': metadata.get('sha256'),
                      'input_sha256': sha(destination), 'original_size': original_size,
                      'input_size': list(display.size), 'attribution': metadata.get('source'),
                      'context': metadata.get('extra', {}),
                      'display_stretch': request.stretch if metadata.get('scientific') and request.source == 'original' else None}


def wsl_path(path):
    resolved = str(path.resolve())
    match = re.match(r'^([A-Za-z]):[\\/](.*)$', resolved)
    if not match:
        raise ValueError('TRELLIS requires a local Windows drive path.')
    return '/mnt/' + match[1].lower() + '/' + match[2].replace('\\', '/')


def validate_glb(path):
    size = path.stat().st_size
    if not 24 <= size <= 256 * 1024 * 1024:
        raise ValueError('Generated model is empty or exceeds the 256 MB viewer limit.')
    with path.open('rb') as stream:
        magic, version, length, json_length, json_type = struct.unpack('<4sIIII', stream.read(20))
        if magic != b'glTF' or version != 2 or length != size or json_type != 0x4E4F534A or json_length > min(size - 20, 32 * 1024 * 1024):
            raise ValueError('The generator did not return a valid GLB model.')
        document = json.loads(stream.read(json_length))
    for entry in document.get('buffers', []) + document.get('images', []):
        if 'uri' in entry:
            raise ValueError('The model must embed its textures and geometry.')
    if not document.get('meshes'):
        raise ValueError('The generated model contains no geometry.')
    return size


def run_trellis(job_id, request, config):
    target = folder(job_id)
    heartbeat = target / 'worker.heartbeat'
    heartbeat.touch()
    command = ['wsl.exe', '-d', config['distribution'], '--exec', config['python'], config['worker'],
               '--input', wsl_path(target / 'input.png'), '--output', wsl_path(target / 'model.glb'),
               '--seed', str(request.seed), '--resolution', str(request.resolution),
               '--cancel-file', wsl_path(target / 'cancel.flag'),
               '--heartbeat-file', wsl_path(heartbeat)]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding='utf-8', errors='replace',
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    lines = queue.Queue(maxsize=500)

    def collect():
        for line in process.stdout:
            try:
                if len(line) <= 16384:
                    lines.put_nowait(line)
            except queue.Full:
                pass
        process.stdout.close()

    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    start = time.monotonic()
    last_heartbeat = start
    failure_hint = None

    def receive_event(line):
        nonlocal failure_hint
        try:
            event = json.loads(line)
            if not isinstance(event, dict):
                return
            if isinstance(event.get('progress'), str):
                update_job(job_id, progress=event['progress'][:240])
            # Only these fixed messages can leave the local worker diagnostics.
            error = str(event.get('error', '')).lower()
            if any(word in error for word in ('gated', 'dinov3', 'hugging face', 'awaiting a review')):
                failure_hint = 'TRELLIS needs approved DINOv3 access on the local Hugging Face account.'
            elif 'out of memory' in error:
                failure_hint = 'TRELLIS ran out of GPU memory. Close other GPU workloads and try 512 resolution.'
            elif 'illegal memory access' in error:
                failure_hint = 'TRELLIS encountered a GPU execution error. Restart the local runtime and retry at 512 resolution.'
        except ValueError:
            pass
    try:
        while process.poll() is None:
            if time.monotonic() - last_heartbeat >= 5:
                heartbeat.touch()
                last_heartbeat = time.monotonic()
            if (target / 'cancel.flag').exists() or time.monotonic() - start > TIMEOUT:
                (target / 'cancel.flag').touch()
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=10)
                if read_job(job_id)['state'] == 'cancelled':
                    return None
                raise RuntimeError('TRELLIS exceeded 30 minutes. Try 512 resolution.')
            try:
                line = lines.get(timeout=.2)
            except queue.Empty:
                continue
            receive_event(line)
        reader.join(timeout=2)
        while not lines.empty():
            receive_event(lines.get_nowait())
        if read_job(job_id)['state'] == 'cancelled':
            return None
        if process.returncode:
            raise RuntimeError(failure_hint or 'TRELLIS could not finish. Check local model access and GPU availability; retry at 512 resolution.')
    finally:
        if process.poll() is None:
            (target / 'cancel.flag').touch()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.terminate()
    return {'model_file': 'model.glb', 'stats': {'resolution': request.resolution}, 'processing': {
        'algorithm': 'TRELLIS.2', 'model': TRELLIS_MODEL, 'local': True, 'ai_generated': True,
        'scientific': False, 'interpretation': 'AI-inferred geometry and unseen surfaces; not measured astronomical depth.'}}


def run_job(job_id, request, metadata, source, config):
    try:
        if read_job(job_id)['state'] == 'cancelled':
            return
        update_job(job_id, state='running', progress='Building astronomy scene…' if request.mode == 'astronomy' else 'Starting local TRELLIS…')
        target = folder(job_id)
        if request.mode == 'astronomy':
            result = astro_scene.generate_scene(target / 'input.png', target, depth=request.depth, seed=request.seed)
        else:
            result = run_trellis(job_id, request, config)
        if result is None or read_job(job_id)['state'] == 'cancelled':
            return
        model = target / result['model_file']
        if model.name != 'model.glb':
            model.replace(target / 'model.glb')
            model = target / 'model.glb'
        size = validate_glb(model)
        asset = {'id': job_id, 'image_id': request.image_id, 'mode': request.mode,
                 'title': metadata['name'], 'created_at': now(),
                 'model_url': f'/api/image-3d/assets/{job_id}/model.glb',
                 'manifest_url': f'/api/image-3d/assets/{job_id}/manifest.json',
                 'source': source, 'processing': result['processing'], 'stats': result['stats'],
                 'settings': request.model_dump(), 'model_sha256': sha(model), 'model_bytes': size,
                 'label': '3D interpretation · depth is inferred, not measured', 'scientific_evidence': False}
        with LOCK:
            if read_job(job_id)['state'] == 'cancelled':
                return
            write_json(target / 'manifest.json', asset)
            update_job(job_id, state='complete', progress='Ready to explore', result=asset)
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else 'The local 3D generator could not complete this image. Please retry.'
        update_job(job_id, state='failed', progress='Generation stopped', error=message[:400])
    finally:
        with LOCK:
            ACTIVE.pop(job_id, None)


@router.post('/jobs')
def create_job(request: CreateJob):
    config = runtime_config() if request.mode == 'trellis' else None
    if request.mode == 'trellis' and not (config and config.get('ready') is True):
        raise HTTPException(409, (config or {}).get('message') or 'Complete local TRELLIS setup first.')
    with LOCK:
        if len(ACTIVE) >= MAX_JOBS:
            raise HTTPException(429, 'The local 3D queue is full. Wait for a job or cancel one.')
        job_id = uuid.uuid4().hex
        target = folder(job_id)
        target.mkdir(parents=True)
        try:
            metadata, source = source_input(request, target / 'input.png')
        except Exception:
            # Only files just created for this request are eligible for cleanup.
            (target / 'input.png').unlink(missing_ok=True)
            target.rmdir()
            raise
        signature = hashlib.sha256(json.dumps({'settings': request.model_dump(), 'input': source['input_sha256']}, sort_keys=True).encode()).hexdigest()
        for active_id in ACTIVE:
            active = read_job(active_id)
            if active.get('signature') == signature and active['state'] in ('queued', 'running'):
                (target / 'input.png').unlink()
                target.rmdir()
                return active
        job = {'id': job_id, 'image_id': request.image_id, 'state': 'queued', 'progress': 'Queued on this PC',
               'created_at': now(), 'updated_at': now(), 'mode': request.mode, 'signature': signature}
        write_json(job_path(job_id), job)
        ACTIVE[job_id] = True
        POOLS[request.mode].submit(run_job, job_id, request, metadata, source, config)
        return job


@router.get('/jobs/{job_id}')
def get_job(job_id: str):
    return read_job(job_id)


@router.post('/jobs/{job_id}/cancel')
def cancel_job(job_id: str):
    with LOCK:
        job = read_job(job_id)
        if job['state'] in ('queued', 'running'):
            (folder(job_id) / 'cancel.flag').touch()
            job = update_job(job_id, state='cancelled', progress='Cancelled', error=None)
        return job


@router.get('/images/{image_id}')
def image_models(image_id: str):
    identifier(image_id)
    science.metadata(image_id)
    rows = []
    for path in (STORE / 'assets').glob('*/manifest.json'):
        try:
            item = json.loads(path.read_text(encoding='utf-8'))
            if item.get('image_id') == image_id:
                rows.append(item)
        except (OSError, ValueError):
            continue
    return {'rows': sorted(rows, key=lambda item: item['created_at'], reverse=True)[:100]}


@router.get('/assets/{asset_id}/{name}')
def asset_file(asset_id: str, name: str):
    if name not in ('model.glb', 'manifest.json'):
        raise HTTPException(404, '3D file not found.')
    directory = folder(asset_id)
    if not (directory / 'manifest.json').is_file() or not (directory / name).is_file():
        raise HTTPException(404, '3D file not found.')
    return FileResponse(directory / name,
                        media_type='model/gltf-binary' if name.endswith('.glb') else 'application/json',
                        filename='UniverseExplorer-3D-interpretation-' + asset_id[:8] + ('.glb' if name.endswith('.glb') else '.json'))


def recover_interrupted():
    for path in (STORE / 'jobs').glob('*.json'):
        try:
            job = json.loads(path.read_text(encoding='utf-8'))
            if job['state'] in ('queued', 'running'):
                (folder(job['id']) / 'cancel.flag').touch()
                job.update(state='failed', progress='Interrupted', error='The app stopped before this job finished. Generate again to retry.', updated_at=now())
                write_json(path, job)
        except (OSError, ValueError, KeyError):
            continue


def cancel_active_jobs():
    with LOCK:
        for job_id in list(ACTIVE):
            cancel_job(job_id)


def stop_jobs():
    cancel_active_jobs()
    for pool in POOLS.values():
        pool.shutdown(wait=False, cancel_futures=True)


recover_interrupted()
atexit.register(stop_jobs)
