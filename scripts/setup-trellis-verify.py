"""Configure and prove the isolated runtime with an actual local GLB output."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import struct
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
path = root / 'data' / 'trellis-runtime.json'
parser = argparse.ArgumentParser()
parser.add_argument('--configure', type=Path)
options = parser.parse_args()
if options.configure:
    runtime = options.configure.resolve()
    config = {
        'schema': 1, 'ready': False, 'distribution': os.environ.get('WSL_DISTRO_NAME', 'Ubuntu-22.04'),
        'python': str(runtime / 'env' / 'bin' / 'python'), 'worker': str(root / 'scripts' / 'trellis_worker.py'),
        'repository': str(runtime / 'TRELLIS.2'), 'model': 'microsoft/TRELLIS.2-4B',
        'verified_at': None, 'message': 'Installing local TRELLIS.2 dependencies and models.',
        'resolutions': [512, 1024],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2), encoding='utf-8')
    sys.exit(0)
config = json.loads(path.read_text(encoding='utf-8-sig'))
config['ready'] = False
config['message'] = 'Verifying local TRELLIS.2 with an astronomy image.'
path.write_text(json.dumps(config, indent=2), encoding='utf-8')
output = root / 'data' / 'trellis-verification' / 'pillars.glb'
process = subprocess.Popen([
    sys.executable, str(root / 'scripts' / 'trellis_worker.py'),
    '--input', str(root / 'static' / 'assets' / 'pillars.jpg'),
    '--output', str(output), '--seed', '42', '--resolution', '512',
], stdout=subprocess.PIPE, text=True, encoding='utf-8')
last_error = None
for line in process.stdout:
    print(line, end='', flush=True)
    try:
        event = json.loads(line)
        last_error = event.get('error') or last_error
    except ValueError:
        pass
returncode = process.wait()
if returncode:
    config['message'] = last_error or 'Local TRELLIS setup needs attention. Rerun scripts/setup-trellis.ps1 after resolving the model access or installation error.'
    path.write_text(json.dumps(config, indent=2), encoding='utf-8')
    sys.exit(returncode)
with output.open('rb') as handle:
    magic, version, size = struct.unpack('<4sII', handle.read(12))
    chunk_size, chunk_type = struct.unpack('<I4s', handle.read(8))
    document = json.loads(handle.read(chunk_size))
if magic != b'glTF' or version != 2 or size != output.stat().st_size or not document.get('meshes'):
    raise RuntimeError('Verification did not produce a valid GLB mesh.')
config.update(ready=True, verified_at=datetime.now(timezone.utc).isoformat(),
              message='Local TRELLIS.2 is ready; image-to-GLB generation verified on this GPU.',
              verification={'image': 'static/assets/pillars.jpg', 'resolution': 512,
                            'output': 'data/trellis-verification/pillars.glb', 'bytes': size})
temporary = path.with_suffix('.tmp')
temporary.write_text(json.dumps(config, indent=2), encoding='utf-8')
temporary.replace(path)
print('Local TRELLIS.2 generated a valid textured GLB from the Pillars of Creation image.')
