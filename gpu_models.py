"""Pinned official Real-ESRGAN release assets; no automatic inference downloads."""
from pathlib import Path
ROOT=Path(__file__).resolve().parent
PYTHON=ROOT/'.venv-gpu'/'Scripts'/'python.exe'
MAX_OUTPUT_PIXELS=64_000_000
MODELS={
 'realesrnet':{'name':'RealESRNet x4plus','label':'Gentle restoration · Real-ESRNet',
  'file':'RealESRNet_x4plus.pth','release':'v0.1.1',
  'sha256':'a820b9bde89a874d7599d545567308ce6c128fc8754a53208eda016d40aa81df'},
 'realesrgan':{'name':'RealESRGAN x4plus','label':'Strong detail · Real-ESRGAN',
  'file':'RealESRGAN_x4plus.pth','release':'v0.1.0',
  'sha256':'4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1'},
}
def model_path(key):return ROOT/'models'/'realesrgan'/MODELS[key]['file']
def model_url(key):
    item=MODELS[key]
    return f"https://github.com/xinntao/Real-ESRGAN/releases/download/{item['release']}/{item['file']}"
