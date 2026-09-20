"""Download official TRELLIS weights without uploading the user's images."""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parents[1]
config = json.loads((root / 'data' / 'trellis-runtime.json').read_text(encoding='utf-8-sig'))
os.environ['HF_HOME'] = str(Path(config['repository']).parent / 'huggingface')
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
token_path = root.parent / '.cache' / 'huggingface' / 'token'
if token_path.is_file():
    os.environ['HF_TOKEN_PATH'] = str(token_path)
from huggingface_hub import snapshot_download
from huggingface_hub.errors import GatedRepoError

snapshot_download('microsoft/TRELLIS.2-4B', allow_patterns=['pipeline.json', 'ckpts/*'], max_workers=4)
snapshot_download('microsoft/TRELLIS-image-large', allow_patterns=['ckpts/ss_dec_conv3d_16l8_fp16*'], max_workers=2)
try:
    snapshot_download('facebook/dinov3-vitl16-pretrain-lvd1689m', allow_patterns=['config.json', 'model.safetensors', 'preprocessor_config.json'], max_workers=2)
except GatedRepoError:
    config['ready'] = False
    config['message'] = 'Local dependencies and public TRELLIS weights are installed. Waiting for this Hugging Face account to receive access to the official DINOv3 model.'
    (root / 'data' / 'trellis-runtime.json').write_text(json.dumps(config, indent=2))
    raise SystemExit('DINOv3 model access is not yet available. After approval, run scripts/setup-trellis.ps1 -VerifyOnly.')
print('Official TRELLIS.2 and DINOv3 weights downloaded.')
