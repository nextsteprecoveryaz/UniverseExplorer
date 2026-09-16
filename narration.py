"""Opt-in OpenAI speech generation with reusable local audio and provenance."""
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Literal
import uuid

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

import cloud_ai


ROOT = Path(__file__).parent / 'data' / 'narration'
MODEL = 'gpt-4o-mini-tts'
VOICES = ('cedar', 'marin', 'coral')
MAX_TEXT_CHARS = 3500
MAX_AUDIO_BYTES = 12 * 1024 * 1024
TIMEOUT_SECONDS = 120
ENDPOINT = 'https://api.openai.com/v1/audio/speech'
INSTRUCTIONS = (
    'Narrate this astronomy tour like an engaging science documentary: warm, '
    'curious, and clear, with a subtle sense of wonder. Use natural pacing, '
    'brief pauses, and varied emphasis to make the discoveries easy to follow. '
    'Avoid a sales pitch or exaggerated drama. Read the supplied text faithfully. Pronounce astronomical '
    'object names and catalogue numbers clearly. Do not add commentary, sound '
    'effects, or music.'
)
DISCLOSURE = 'AI-generated narration by OpenAI.'
router = APIRouter(prefix='/api/narration', tags=['Narration'])
_inflight = {}


class ClipRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice: Literal['cedar', 'marin', 'coral'] = 'cedar'

    @field_validator('text')
    @classmethod
    def valid_unicode(cls, value):
        try:
            value.encode('utf-8')
        except UnicodeError as exc:
            raise ValueError('Narration text must contain valid Unicode.') from exc
        return value


def cache_key(request):
    identity = {'model': MODEL, 'voice': request.voice, 'text': request.text,
                'instructions': INSTRUCTIONS, 'response_format': 'mp3'}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode('utf-8')).hexdigest()


def paths(key):
    if not re.fullmatch(r'[a-f0-9]{64}', key):
        raise HTTPException(404, 'Narration audio not found.')
    root = ROOT.resolve()
    audio, metadata = root / (key + '.mp3'), root / (key + '.json')
    if audio.resolve().parent != root or metadata.resolve().parent != root:
        raise HTTPException(404, 'Narration audio not found.')
    return audio, metadata


def result(request, key, cached):
    return {'url': f'/api/narration/audio/{key}.mp3', 'cached': cached,
            'cache_key': key, 'model': MODEL, 'voice': request.voice,
            'text': request.text, 'disclosure': DISCLOSURE}


def cached_clip(request, key):
    audio, metadata = paths(key)
    try:
        saved = json.loads(metadata.read_text(encoding='utf-8'))
        size = audio.stat().st_size
        if (isinstance(saved, dict) and saved.get('cache_key') == key
                and saved.get('model') == MODEL and saved.get('voice') == request.voice
                and saved.get('text') == request.text and saved.get('instructions') == INSTRUCTIONS
                and 0 < size <= MAX_AUDIO_BYTES and saved.get('bytes') == size):
            return result(request, key, True)
    except (OSError, ValueError, UnicodeError):
        pass
    return None


def api_error(status):
    if status == 401:
        return HTTPException(401, 'OpenAI rejected the API key. Reconnect OpenAI in this app.')
    if status in (403, 404):
        return HTTPException(403, 'This OpenAI project does not have access to the narration model.')
    if status == 429:
        return HTTPException(429, 'OpenAI reported a quota or rate limit. Check API billing and limits before retrying.')
    return HTTPException(502, 'OpenAI could not generate this narration. Check your API dashboard before retrying.')


def make_client():
    # httpx does not retry by default; repeat speech requests may incur charges.
    return httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT_SECONDS, connect=15),
                             follow_redirects=False)


def mp3_signature(content):
    return (content.startswith(b'ID3') or
            (len(content) >= 2 and content[0] == 0xff and content[1] & 0xe0 == 0xe0
             and content[1] & 0x06 != 0))


async def generate(request, key):
    # The shared task owns generation even if an HTTP caller goes away.
    existing = cached_clip(request, key)
    if existing:
        return existing
    try:
        api_key = cloud_ai.get_key()
    except (cloud_ai.CloudError, OSError, UnicodeError):
        raise HTTPException(409, 'The saved OpenAI key could not be read. Reconnect OpenAI in this app.') from None
    if not api_key:
        raise HTTPException(409, 'Connect an OpenAI API key in this app to create narration. Saved audio remains playable.')
    payload = {'model': MODEL, 'voice': request.voice, 'input': request.text,
               'instructions': INSTRUCTIONS, 'response_format': 'mp3'}
    content = bytearray()
    request_id = None
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async with make_client() as client:
                async with client.stream('POST', ENDPOINT,
                                         headers={'Authorization': 'Bearer ' + api_key},
                                         json=payload) as response:
                    if not response.is_success:
                        raise api_error(response.status_code)
                    media_type = response.headers.get('content-type', '').split(';')[0].lower()
                    if media_type not in ('audio/mpeg', 'audio/mp3', 'audio/x-mpeg',
                                          'application/octet-stream'):
                        raise HTTPException(502, 'OpenAI returned no usable MP3 audio. Check the API dashboard before retrying.')
                    length = response.headers.get('content-length', '')
                    if length.isdigit() and int(length) > MAX_AUDIO_BYTES:
                        raise HTTPException(502, 'The narration exceeded the audio size limit. Try a shorter passage.')
                    async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                        content.extend(chunk)
                        if len(content) > MAX_AUDIO_BYTES:
                            raise HTTPException(502, 'The narration exceeded the audio size limit. Try a shorter passage.')
                    identifier = response.headers.get('x-request-id', '')
                    if re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', identifier):
                        request_id = identifier
    except (httpx.HTTPError, TimeoutError):
        raise HTTPException(504, 'The OpenAI connection ended before narration arrived. Check your API dashboard before retrying; the request may have been processed.') from None
    if not content or not mp3_signature(content):
        raise HTTPException(502, 'OpenAI returned no usable MP3 audio. Check the API dashboard before retrying.')

    audio, metadata = paths(key)
    suffix = '.' + uuid.uuid4().hex + '.tmp'
    audio_temp, metadata_temp = audio.with_suffix(suffix), metadata.with_suffix('.json' + suffix)
    provenance = {'cache_key': key, 'provider': 'OpenAI', 'model': MODEL,
                  'voice': request.voice, 'text': request.text, 'instructions': INSTRUCTIONS,
                  'response_format': 'mp3', 'ai_generated': True, 'disclosure': DISCLOSURE,
                  'created_at': datetime.now(timezone.utc).isoformat(), 'request_id': request_id,
                  'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(),
                  'documentation_url': 'https://developers.openai.com/api/docs/guides/text-to-speech'}
    try:
        ROOT.mkdir(parents=True, exist_ok=True)
        audio_temp.write_bytes(content)
        metadata_temp.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        audio_temp.replace(audio)
        metadata_temp.replace(metadata)
    except OSError:
        raise HTTPException(500, 'Narration was generated but could not be saved locally. Check available disk space before retrying.') from None
    finally:
        for temporary in (audio_temp, metadata_temp):
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    return result(request, key, False)


@router.get('/status')
def status():
    problem = None
    try:
        configured = bool(cloud_ai.get_key())
    except (cloud_ai.CloudError, OSError, UnicodeError):
        configured = False
        problem = 'The saved OpenAI key could not be read. Reconnect OpenAI in this app.'
    return {'configured': configured, 'model': MODEL, 'voices': list(VOICES),
            'default_voice': 'cedar', 'max_text_chars': MAX_TEXT_CHARS,
            'disclosure': DISCLOSURE, 'problem': problem}


@router.post('/clip')
async def clip(request: ClipRequest):
    key = cache_key(request)
    existing = cached_clip(request, key)
    if existing:
        return existing
    task = _inflight.get(key)
    if task is None:
        task = asyncio.create_task(generate(request, key))
        _inflight[key] = task

        def completed(done):
            if _inflight.get(key) is done:
                _inflight.pop(key, None)
            # Retrieve failures if all clients navigated away during generation.
            if not done.cancelled():
                done.exception()

        task.add_done_callback(completed)
    return await asyncio.shield(task)


@router.get('/audio/{key}.mp3')
def audio(key: str):
    path, _ = paths(key)
    try:
        available = path.is_file() and 0 < path.stat().st_size <= MAX_AUDIO_BYTES
    except OSError:
        available = False
    if not available:
        raise HTTPException(404, 'Narration audio not found.')
    return FileResponse(path, media_type='audio/mpeg',
                        headers={'Cache-Control': 'private, max-age=31536000, immutable'})
