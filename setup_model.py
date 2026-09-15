import hashlib
from pathlib import Path
import httpx

ROOT=Path(__file__).parent/'models'
ROOT.mkdir(exist_ok=True)
HASH='366b33f0084c7b3f2bf6724f0a2c77bca94fcec9d7b6d72389d330073b380d5c'
target=ROOT/'FSRCNN_x2.pb'
if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==HASH:
    print('Local FSRCNN model is installed and verified.')
else:
    with httpx.Client(timeout=60,follow_redirects=True) as c:
        r=c.get('https://raw.githubusercontent.com/Saafke/FSRCNN_Tensorflow/master/models/FSRCNN_x2.pb')
        r.raise_for_status()
        if hashlib.sha256(r.content).hexdigest()!=HASH:
            raise RuntimeError('Model checksum changed. Review the upstream model before updating.')
        target.write_bytes(r.content)
        license=c.get('https://raw.githubusercontent.com/Saafke/FSRCNN_Tensorflow/master/LICENSE')
        license.raise_for_status()
        (ROOT/'LICENSE-FSRCNN.txt').write_text(license.text,encoding='utf-8')
    print('Installed verified local FSRCNN x2 model (39 KB).')
