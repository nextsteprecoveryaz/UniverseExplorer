"""Install hash-pinned model weights and verify the isolated CUDA runtime."""
import hashlib,json,subprocess,urllib.request
from pathlib import Path
from gpu_models import ROOT,PYTHON,MODELS,model_path,model_url

def main():
    for key,model in MODELS.items():
        path=model_path(key);path.parent.mkdir(parents=True,exist_ok=True)
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest()!=model['sha256']:
            print('Downloading '+model['name'],flush=True);temp=path.with_suffix('.download')
            try:
                with urllib.request.urlopen(model_url(key),timeout=120) as response,temp.open('wb') as output:
                    while data:=response.read(1024*1024):output.write(data)
                if hashlib.sha256(temp.read_bytes()).hexdigest()!=model['sha256']:raise ValueError('Downloaded model checksum mismatch.')
                temp.replace(path)
            finally:temp.unlink(missing_ok=True)
        print('Verified '+model['name'],flush=True)
    result=subprocess.run([str(PYTHON),str(ROOT/'scripts'/'gpu_upscale_worker.py'),'--probe'],capture_output=True,text=True,timeout=120)
    if result.returncode:raise RuntimeError(result.stdout+result.stderr)
    info=json.loads(result.stdout.strip().splitlines()[-1]);(ROOT/'data').mkdir(exist_ok=True)
    (ROOT/'data'/'gpu-runtime.json').write_text(json.dumps(info,indent=2));print(json.dumps(info),flush=True)

if __name__=='__main__':main()
