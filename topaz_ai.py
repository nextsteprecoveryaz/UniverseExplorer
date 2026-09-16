"""Explicit, opt-in Topaz upscaling. No submission retries or client-side keys."""
import asyncio
import hashlib
import io
import json
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
    result = cloud_ai.save_result(image_id, content, provider='Topaz cloud', model=MODEL,
        prompt=json.dumps({'operation': 'Precision upscale', 'scale': job['scale'],
                           'face_enhancement': False, 'input_source': job['input_source'],
                           'input_stretch': job['stretch']}, sort_keys=True),
        input_size=job['input_size'], input_sha256=job['input_sha256'], request_id=job['process_id'])
    result['cloud_ai'].update({'scale': job['scale'], 'input_source': job['input_source'],
                              'input_stretch': job['stretch']})
    result.pop('topaz_pending', None)
    science.save_metadata(result)
    return result


async def enhance(image_id, scale=2, stretch='asinh'):
    global BALANCE
    key = get_key()
    if not key:
        raise TopazError('Connect Topaz in Image Lab before upscaling.', 409)
    metadata, content, input_size, source = await run_in_threadpool(prepare, image_id, scale, stretch)
    digest = hashlib.sha256(content).hexdigest()
    job = metadata.get('topaz_pending')
    if job and (job.get('input_sha256') != digest or job.get('scale') != scale):
        raise TopazError('A Topaz job is already saved for this image. Use its original scale and display stretch to retrieve it before starting another.', 409)
    try:
        async with make_client() as client:
            if not job:
                # A submission is a paid operation; never automatically resubmit it.
                response = await client.post(BASE_URL + '/enhance/async', headers={'X-API-Key': key},
                    data={'model': MODEL, 'output_format': 'png', 'output_width': str(input_size[0] * scale),
                          'output_height': str(input_size[1] * scale), 'face_enhancement': 'false', 'crop_to_fill': 'false'},
                    files={'image': ('astronomy-display.png', content, 'image/png')})
                value = response_json(response)
                job = {'process_id': process_id(value.get('process_id')), 'scale': scale,
                       'model': MODEL, 'input_sha256': digest, 'input_size': input_size,
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
