"""Explicit, opt-in Topaz upscaling. No submission retries or client-side keys."""
import asyncio
import hashlib
import io
import json
import math
import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import numpy as np
from PIL import Image
from starlette.concurrency import run_in_threadpool

import cloud_ai
import integrations
import science

MODEL = 'Standard V2'
BASE_URL = 'https://api.topazlabs.com/image/v1'
BALANCE_URL = 'https://api.topazlabs.com/account/v1/credits/balance'
KEY_FILE = Path(__file__).parent / 'data' / 'topaz-key.dpapi'
MAX_OUTPUT_PIXELS = 25_000_000
MAX_BYTES = 100 * 1024 * 1024
POLL_SECONDS = 2
WAIT_SECONDS = 300
SESSION_KEY = None
BALANCE = None


def number_parameter(key, label, minimum, maximum, default=None, step=.05, integer=False):
    return {'key': key, 'label': label, 'type': 'integer' if integer else 'number',
            'min': minimum, 'max': maximum, 'step': step, 'default': default}


PRECISION_PARAMETERS = [number_parameter('sharpen', 'Sharpen', 0, 1),
                        number_parameter('denoise', 'Denoise', 0, 1)]
PROMPT_PARAMETER = {'key': 'prompt', 'label': 'Describe the result', 'type': 'text',
                    'max_length': 1024, 'default': ''}
GRAIN_PARAMETER = {'key': 'grain', 'label': 'Add film grain', 'type': 'boolean', 'default': False}

# Model-specific pages are current; the shared OpenAPI model enum trails new releases.
# Base request fields use snake_case; model options retain their documented names.
MODELS = [
    {'id': MODEL, 'label': 'Standard 2', 'family': 'Precision', 'endpoint': '/enhance/async',
     'description': 'Balanced enlargement with automatic detail and noise adjustments.',
     'parameters': PRECISION_PARAMETERS,
     'source_url': 'https://developer.topazlabs.com/image-models/gigapixel/standard-2'},
    {'id': 'High Fidelity V2', 'label': 'High Fidelity 2', 'family': 'Precision', 'endpoint': '/enhance/async',
     'description': 'Enlarge well-captured images while retaining their original structure and texture.',
     'parameters': PRECISION_PARAMETERS,
     'source_url': 'https://developer.topazlabs.com/image-models/gigapixel/high-fidelity-2'},
    {'id': 'Upscale High Fidelity V3', 'label': 'High Fidelity 3', 'family': 'Precision', 'endpoint': '/enhance/async',
     'description': 'Newer fidelity model for clean sources, with adjustable recovery and blending.',
     'parameters': [*PRECISION_PARAMETERS, number_parameter('recoveryStrength', 'Recovery strength', 0, 1, 1),
                    number_parameter('opacity', 'Enhancement opacity', 0, 1, 1)],
     'source_url': 'https://developer.topazlabs.com/image-models/gigapixel/high-fidelity-3'},
    {'id': 'Bloom 2', 'label': 'Bloom 2', 'family': 'Creative', 'endpoint': '/enhance-gen/async',
     'description': 'Reimagine textures and introduce new detail. Designed for creative visualizations and AI artwork.',
     'parameters': [number_parameter('creativity', 'Creativity', 1, 9, 3, step=1, integer=True),
                    {'key': 'colorPreservation', 'label': 'Preserve source colors', 'type': 'boolean', 'default': True},
                    PROMPT_PARAMETER, GRAIN_PARAMETER],
     'source_url': 'https://developer.topazlabs.com/image-models/bloom/bloom-2-new-and-improved'},
    {'id': 'Wonder 3.5', 'label': 'Wonder 3.5', 'family': 'Generative', 'endpoint': '/enhance-gen/async',
     'description': 'Generate refined detail and texture in compressed or degraded images.',
     'parameters': [{'key': 'enhancementStrength', 'label': 'Enhancement strength', 'type': 'enum',
                     'options': ['low', 'medium', 'high'], 'default': 'medium'}, GRAIN_PARAMETER],
     'source_url': 'https://developer.topazlabs.com/image-models/wonder/wonder-3.5-new'},
    {'id': 'Recover 3', 'label': 'Recover 3', 'family': 'Generative', 'endpoint': '/enhance-gen/async',
     'description': 'Reconstruct detail in small or blurry images, with control over generated texture.',
     'max_input_pixels': 24_000_000,
     'parameters': [number_parameter('enhancementStrength', 'Recovery strength', 0, 10, 5, step=.5),
                    number_parameter('creativity', 'Creativity', 1, 9, 3, step=1, integer=True),
                    number_parameter('texture', 'Texture', 1, 5, 1, step=1, integer=True), PROMPT_PARAMETER],
     'source_url': 'https://developer.topazlabs.com/image-models/wonder/recover-3'},
]


def model_catalog():
    return {'default_model': MODEL, 'max_output_pixels': MAX_OUTPUT_PIXELS, 'scales': [2, 4],
            'models': [{key: value for key, value in model.items() if key != 'endpoint'} for model in MODELS]}


def model_settings(model=MODEL, parameters=None):
    selected = next((item for item in MODELS if item['id'] == model), None)
    if selected is None:
        raise TopazError('Choose one of the available Topaz models.')
    if parameters is None:
        parameters = {}
    if not isinstance(parameters, dict):
        raise TopazError('Topaz model settings must be an object.')
    supported = {item['key'] for item in selected['parameters']}
    if parameters.keys() - supported:
        raise TopazError('This model does not support one or more of the selected settings.')
    normalized = {}
    for setting in selected['parameters']:
        value = parameters.get(setting['key'], setting['default'])
        if value is None and setting['default'] is None:
            continue  # Automatic provider tuning: omit the field, do not send null.
        kind = setting['type']
        valid = False
        if kind == 'boolean':
            valid = isinstance(value, bool)
        elif kind == 'text':
            valid = isinstance(value, str) and len(value) <= setting['max_length']
        elif kind == 'enum':
            valid = isinstance(value, str) and value in setting['options']
        elif kind in ('number', 'integer'):
            valid = (isinstance(value, (float, int)) and not isinstance(value, bool)
                     and math.isfinite(value) and setting['min'] <= value <= setting['max']
                     and (kind != 'integer' or isinstance(value, int)))
        if not valid:
            raise TopazError('Choose a valid value for ' + setting['label'].lower() + '.')
        normalized[setting['key']] = value
    return selected, normalized


class TopazError(cloud_ai.CloudError):
    pass


def protect(data, decrypt=False):
    try:
        return cloud_ai.protect(data, decrypt=decrypt)
    except cloud_ai.CloudError as exc:
        raise TopazError('Windows could not unlock or save the Topaz key. Reconnect Topaz, or use a session-only key.') from exc


def get_key():
    if SESSION_KEY:
        return SESSION_KEY
    if KEY_FILE.exists():
        return protect(KEY_FILE.read_bytes(), decrypt=True).decode()
    return os.environ.get('TOPAZ_API_KEY', '').strip()


def status():
    try:
        configured, problem = bool(get_key()), None
    except (cloud_ai.CloudError, OSError, UnicodeError):
        configured, problem = False, 'Saved key could not be read. Reconnect Topaz.'
    return {'configured': configured, 'model': MODEL, 'max_output_pixels': MAX_OUTPUT_PIXELS,
            'storage': ('Windows encrypted storage' if KEY_FILE.exists() else
                        'session' if SESSION_KEY else 'environment' if configured else None),
            'problem': problem, 'available_credits': BALANCE if configured else None}


def make_client():
    # Never attach the key as a default header: result URLs belong to storage hosts.
    return httpx.AsyncClient(timeout=httpx.Timeout(90, connect=20), follow_redirects=False)


def response_error(response):
    messages = {
        401: 'Topaz rejected the API key. Reconnect Topaz with a valid key.',
        402: 'Topaz requires API credits for this upscale. Check your Topaz API balance.',
        403: 'This Topaz key does not have permission to use the requested API.',
        429: 'Topaz reported a rate limit. Wait before checking the job again.',
    }
    # Do not expose upstream bodies: providers can echo headers and request data.
    return TopazError(messages.get(response.status_code,
        'Topaz could not complete this request. Check your Topaz API jobs before starting another upscale.'),
        response.status_code if response.status_code in messages else 502)


def response_json(response):
    if not response.is_success:
        raise response_error(response)
    try:
        value = response.json()
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, TypeError) as exc:
        raise TopazError('Topaz returned an unreadable response. Check your API jobs before retrying.', 502) from exc


async def connect(key, remember=False):
    global SESSION_KEY, BALANCE
    key = key.strip()
    if not 20 <= len(key) <= 1000 or any(c.isspace() for c in key):
        raise TopazError('Enter a valid Topaz API key.')
    try:
        async with make_client() as client:
            value = response_json(await client.get(BALANCE_URL, headers={'X-API-Key': key}, timeout=25))
    except httpx.HTTPError as exc:
        raise TopazError('Could not verify the Topaz connection. No upscale was submitted.', 502) from exc
    balance = value.get('available_credits')
    if not isinstance(balance, (int, float)) or isinstance(balance, bool):
        raise TopazError('Topaz did not return a valid account balance. The key was not saved.', 502)
    try:
        if remember:
            encrypted = protect(key.encode())
            KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
            KEY_FILE.write_bytes(encrypted)
        elif KEY_FILE.exists():
            KEY_FILE.unlink()
    except OSError as exc:
        raise TopazError('The Topaz key could not be saved. Try a session-only connection.') from exc
    SESSION_KEY, BALANCE = key, balance
    return status()


def disconnect():
    global SESSION_KEY, BALANCE
    if KEY_FILE.exists():
        KEY_FILE.unlink()
    SESSION_KEY, BALANCE = None, None
    return status()


def prepare(image_id, scale=2, stretch='asinh'):
    if scale not in (2, 4) or isinstance(scale, bool):
        raise TopazError('Choose a 2x or 4x upscale.')
    if stretch not in ('asinh', 'linear', 'log'):
        raise TopazError('Choose a supported FITS display stretch.')
    metadata = science.metadata(image_id)
    width, height = metadata['width'], metadata['height']
    if width * height * scale * scale > MAX_OUTPUT_PIXELS or max(width, height) * scale > 32000:
        raise TopazError('This upscale would exceed 25 million pixels or 32,000 pixels per side. Choose a smaller scale or crop a copy first.')
    if metadata['scientific']:
        array = np.load(science.IMAGES / (image_id + '.npy'), allow_pickle=False)
        image = Image.fromarray(np.flipud(science.stretch_array(array, stretch))).convert('RGB')
        source = 'Full-resolution FITS display raster (' + stretch + '); not calibrated pixel data'
    else:
        with Image.open(science.IMAGES / metadata['original_file']) as original:
            image = original.convert('RGB')
        source = 'Full-resolution original image, converted to RGB PNG'
    if image.size != (width, height):
        raise TopazError('The original dimensions changed. Reimport this image before upscaling.')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    content = buffer.getvalue()
    if len(content) > MAX_BYTES:
        raise TopazError('The prepared image exceeds 100 MB. Crop a copy before upscaling.')
    return metadata, content, [width, height], source


def process_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise TopazError('Topaz returned no usable job identifier. Check your API jobs before retrying.', 502) from exc


def result_url(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        allowed = ('topazlabs.com', 'amazonaws.com', 'storage.googleapis.com', 'r2.cloudflarestorage.com')
        if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443)
                or not any(host == domain or host.endswith('.' + domain) for domain in allowed)):
            raise ValueError()
        return value
    except (ValueError, AttributeError, TypeError) as exc:
        raise TopazError('Topaz returned an unsupported result location. The saved job can be checked again without another submission.', 502) from exc


async def wait_for_result(client, key, job_id):
    headers = {'X-API-Key': key}
    while True:
        response = await client.get(BASE_URL + '/status/' + job_id, headers=headers)
        # Polling is read-only and may be retried; submission never is.
        if response.status_code == 429 or response.status_code >= 500:
            await asyncio.sleep(max(5, POLL_SECONDS))
            continue
        value = response_json(response)
        state = value.get('status')
        if state == 'Completed':
            break
        if state in ('Failed', 'Cancelled'):
            error = TopazError('Topaz marked job ' + job_id + ' ' + state.lower() + '. Check your Topaz account before submitting another upscale.', 502)
            error.terminal_state = state
            raise error
        if state not in ('Pending', 'Processing'):
            raise TopazError('Topaz returned an unknown job state. Check the saved job again later.', 502)
        await asyncio.sleep(POLL_SECONDS)
    download = response_json(await client.get(BASE_URL + '/download/' + job_id, headers=headers))
    # The OpenAPI reference uses download_url; the quickstart still shows url.
    url = result_url(download.get('download_url') or download.get('url'))
    chunks, size = [], 0
    async with client.stream('GET', url) as response:
        if not response.is_success:
            raise TopazError('The Topaz result could not be downloaded. Check the saved job again later.', 502)
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_BYTES:
                raise TopazError('The Topaz result exceeds the 100 MB download limit.', 502)
            chunks.append(chunk)
    return b''.join(chunks)


def save_result(image_id, content, job):
    try:
        with Image.open(io.BytesIO(content)) as image:
            if list(image.size) != job['output_size']:
                raise TopazError('Topaz returned unexpected output dimensions. The original remains unchanged.', 502)
    except (OSError, Image.DecompressionBombError) as exc:
        raise TopazError('Topaz returned an unsupported image. The original remains unchanged.', 502) from exc
    selected, parameters = model_settings(job.get('model', MODEL), job.get('parameters'))
    result = cloud_ai.save_result(image_id, content, provider='Topaz cloud', model=selected['id'],
        prompt=json.dumps({'operation': selected['family'] + ' upscale', 'scale': job['scale'],
                           'model': selected['id'], 'parameters': parameters,
                           'face_enhancement': False, 'input_source': job['input_source'],
                           'input_stretch': job['stretch']}, sort_keys=True),
        input_size=job['input_size'], input_sha256=job['input_sha256'], request_id=job['process_id'])
    result['cloud_ai'].update({'scale': job['scale'], 'input_source': job['input_source'],
                              'model_label': selected['label'], 'model_family': selected['family'],
                              'parameters': parameters,
                              'input_stretch': job['stretch']})
    result.pop('topaz_pending', None)
    science.save_metadata(result)
    return result


async def enhance(image_id, scale=2, stretch='asinh', model=MODEL, parameters=None):
    global BALANCE
    selected, parameters = model_settings(model, parameters)
    key = get_key()
    if not key:
        raise TopazError('Connect Topaz in Image Lab before upscaling.', 409)
    metadata, content, input_size, source = await run_in_threadpool(prepare, image_id, scale, stretch)
    if input_size[0] * input_size[1] > selected.get('max_input_pixels', MAX_OUTPUT_PIXELS):
        raise TopazError('The input exceeds this model\'s resolution limit. Crop a copy first.')
    digest = hashlib.sha256(content).hexdigest()
    job = metadata.get('topaz_pending')
    if job and (job.get('input_sha256') != digest or job.get('scale') != scale
                or job.get('model', MODEL) != model or job.get('parameters', {}) != parameters):
        raise TopazError('A Topaz job is already saved for this image. Use its original scale, model, model settings and display stretch to retrieve it before starting another.', 409)
    try:
        async with make_client() as client:
            if not job:
                # A submission is a paid operation; never automatically resubmit it.
                fields = {'model': model, 'output_format': 'png', 'output_width': str(input_size[0] * scale),
                          'output_height': str(input_size[1] * scale), 'face_enhancement': 'false', 'crop_to_fill': 'false',
                          **{name: ('true' if value else 'false') if isinstance(value, bool) else str(value)
                             for name, value in parameters.items()}}
                response = await client.post(BASE_URL + selected['endpoint'], headers={'X-API-Key': key},
                    data=fields,
                    files={'image': ('astronomy-display.png', content, 'image/png')})
                value = response_json(response)
                job = {'process_id': process_id(value.get('process_id')), 'scale': scale,
                       'model': model, 'parameters': parameters, 'input_sha256': digest, 'input_size': input_size,
                       'output_size': [dimension * scale for dimension in input_size],
                       'stretch': stretch if metadata['scientific'] else None,
                       'input_source': source, 'created_at': integrations.now()}
                # Keep the job across a poll timeout or server restart to avoid a second paid submission.
                metadata['topaz_pending'] = job
                science.save_metadata(metadata)
                BALANCE = None
            output = await asyncio.wait_for(wait_for_result(client, key, process_id(job['process_id'])), WAIT_SECONDS)
    except TopazError as exc:
        if job and getattr(exc, 'terminal_state', None):
            metadata.pop('topaz_pending', None)
            metadata['topaz_last_job'] = {**job, 'status': exc.terminal_state}
            science.save_metadata(metadata)
        raise
    except (httpx.HTTPError, TimeoutError) as exc:
        if job:
            message = 'Topaz job ' + process_id(job['process_id']) + ' is saved, but its result is not ready here. Click Upscale again with the same settings to check it without another submission.'
        else:
            message = 'The Topaz connection ended before a job identifier arrived. Check your Topaz API jobs before trying again; an upscale may have been submitted.'
        raise TopazError(message, 504) from exc
    return await run_in_threadpool(save_result, image_id, output, job)
