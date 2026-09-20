"""Install a pinned, checksum-verified Three.js viewer for local/offline previews."""
import hashlib
import json
from pathlib import Path

import httpx

VERSION = '0.180.0'
DESTINATION = Path(__file__).parent / 'static' / 'vendor' / 'three'
# GLTFLoader's checksum is after flattening its one relative addon import.
FILES = [
    ('three.module.js', 'build/three.module.js', 'c8211c69345d2e9949dc7a8ac969380497aa0600a5a8ac6a459c8cd02dd9cb8a'),
    ('three.core.js', 'build/three.core.js', 'eb077d2417f61d3e6d9264c317cabc4ea35769ed6b0ab533067292a550784c20'),
    ('OrbitControls.js', 'examples/jsm/controls/OrbitControls.js', 'b97879c748170baadeb3fb84cea1ffdf4674e283dc06042f34e2acb95a76042c'),
    ('GLTFLoader.js', 'examples/jsm/loaders/GLTFLoader.js', 'adbbafe8ce40416525b6be0ee5cac0d3782482bcf0122c8ca8ec1ffa77d3440b'),
    ('BufferGeometryUtils.js', 'examples/jsm/utils/BufferGeometryUtils.js', 'fda7e946b8e0b5ab39b779206589e7a1079a22eb24efb89d7223e03fdfb1f751'),
    ('LICENSE', 'LICENSE', 'bfe119ea4fd413f5f7ca3fcd63adb0c4a073ed39daa2fe7d3e6b769e21272601'),
]


def install():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    manifest = {'package': 'three', 'version': VERSION, 'files': []}
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for name, upstream, expected in FILES:
            path = DESTINATION / name
            source = f'https://unpkg.com/three@{VERSION}/{upstream}'
            data = path.read_bytes() if path.is_file() else b''
            if hashlib.sha256(data).hexdigest() != expected:
                response = client.get(source)
                response.raise_for_status()
                data = response.content
                if name == 'GLTFLoader.js':
                    data = data.replace(b'../utils/BufferGeometryUtils.js', b'./BufferGeometryUtils.js')
                if hashlib.sha256(data).hexdigest() != expected:
                    raise RuntimeError('Three.js checksum mismatch: ' + name)
                temporary = path.with_suffix(path.suffix + '.download')
                temporary.write_bytes(data)
                temporary.replace(path)
            manifest['files'].append({'file': name, 'source': source, 'sha256': expected,
                                      'patched_relative_import': name == 'GLTFLoader.js'})
            print('Verified Three.js ' + name)
    (DESTINATION / 'provenance.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')


if __name__ == '__main__':
    install()
