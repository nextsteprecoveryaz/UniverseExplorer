"""Isolated CUDA worker. RRDB architecture adapted from BasicSR (Apache-2.0).
See licenses/BasicSR.txt. Original network: Xintao Wang and contributors.
"""
import sys,json,hashlib,time,math
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import numpy as np
from PIL import Image
import torch
from torch import nn
from torch.nn import functional as F
from gpu_models import MODELS,model_path,MAX_OUTPUT_PIXELS

class ResidualDenseBlock(nn.Module):
    def __init__(self):
        super().__init__()
        for i in range(1,6):setattr(self,f'conv{i}',nn.Conv2d(64+32*(i-1),32 if i<5 else 64,3,1,1))
        self.lrelu=nn.LeakyReLU(.2,inplace=True)
    def forward(self,x):
        values=[x]
        for i in range(1,5):values.append(self.lrelu(getattr(self,f'conv{i}')(torch.cat(values,1))))
        return self.conv5(torch.cat(values,1))*.2+x

class RRDB(nn.Module):
    def __init__(self):
        super().__init__();self.rdb1=ResidualDenseBlock();self.rdb2=ResidualDenseBlock();self.rdb3=ResidualDenseBlock()
    def forward(self,x):return self.rdb3(self.rdb2(self.rdb1(x)))*.2+x

class RRDBNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_first=nn.Conv2d(3,64,3,1,1);self.body=nn.Sequential(*[RRDB() for _ in range(23)])
        self.conv_body=nn.Conv2d(64,64,3,1,1);self.conv_up1=nn.Conv2d(64,64,3,1,1);self.conv_up2=nn.Conv2d(64,64,3,1,1)
        self.conv_hr=nn.Conv2d(64,64,3,1,1);self.conv_last=nn.Conv2d(64,3,3,1,1);self.lrelu=nn.LeakyReLU(.2,inplace=True)
    def forward(self,x):
        x=self.conv_first(x);x=x+self.conv_body(self.body(x))
        x=self.lrelu(self.conv_up1(F.interpolate(x,scale_factor=2,mode='nearest')))
        x=self.lrelu(self.conv_up2(F.interpolate(x,scale_factor=2,mode='nearest')))
        return self.conv_last(self.lrelu(self.conv_hr(x)))

def emit(**data):print(json.dumps(data),flush=True)
def probe():
    if not torch.cuda.is_available():raise RuntimeError('CUDA is unavailable. Install a current NVIDIA driver and run Setup-GPU.cmd.')
    # Run a real CUDA kernel, not only a device enumeration.
    x=torch.ones((8,8),device='cuda');assert float((x@x)[0,0])==8
    return {'gpu':torch.cuda.get_device_name(0),'vram_gib':round(torch.cuda.get_device_properties(0).total_memory/2**30,1),'torch':torch.__version__,'cuda':torch.version.cuda}

def run(config):
    started=time.perf_counter();device=probe();emit(progress=2,message='Loading model on '+device['gpu'])
    model=MODELS[config['model']];path=model_path(config['model'])
    if hashlib.sha256(path.read_bytes()).hexdigest()!=model['sha256']:raise ValueError('Model checksum mismatch. Run Setup-GPU.cmd again.')
    net=RRDBNet();weights=torch.load(path,map_location='cpu',weights_only=True)
    net.load_state_dict(weights.get('params_ema',weights.get('params')),strict=True);net.eval().cuda()
    half=config['precision']=='fp16'
    if half:net.half()
    torch.set_num_threads(4);torch.backends.cudnn.benchmark=False
    # TF32 disabled for the FP32 quality option.
    torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
    original=Image.open(config['input']);alpha=original.getchannel('A') if 'A' in original.getbands() else None
    image=original.convert('RGB');w,h=image.size;scale=config['scale']
    if w*h*scale*scale>MAX_OUTPUT_PIXELS:raise ValueError('Output exceeds 64 megapixels. Choose 2× or crop the source.')
    pixels=np.asarray(image);output=np.empty((h*scale,w*scale,3),dtype=np.uint8)
    tile=config['tile'];pad=32;total=math.ceil(w/tile)*math.ceil(h/tile);done=0
    with torch.inference_mode():
        for y in range(0,h,tile):
            for x in range(0,w,tile):
                x1=min(w,x+tile);y1=min(h,y+tile);left=max(0,x-pad);top=max(0,y-pad);right=min(w,x1+pad);bottom=min(h,y1+pad)
                part=torch.from_numpy(pixels[top:bottom,left:right].copy()).permute(2,0,1).unsqueeze(0).cuda().float().div_(255)
                if half:part=part.half()
                try:result=net(part)
                except torch.cuda.OutOfMemoryError as exc:raise RuntimeError('GPU memory is busy. Choose a smaller tile size or FP16 and retry.') from exc
                if not torch.isfinite(result).all():raise RuntimeError('Non-finite GPU output. Retry with FP32 precision.')
                if scale==2:result=F.interpolate(result.float(),scale_factor=.5,mode='bicubic',align_corners=False,antialias=True)
                result=result[:,:, (y-top)*scale:(y1-top)*scale,(x-left)*scale:(x1-left)*scale]
                output[y*scale:y1*scale,x*scale:x1*scale]=result[0].float().clamp_(0,1).mul_(255).round_().permute(1,2,0).cpu().numpy().astype(np.uint8)
                del part,result;done+=1;emit(progress=5+int(85*done/total),message=f'GPU tile {done} of {total}')
    result=Image.fromarray(output)
    if config['strength']<1:result=Image.blend(image.resize(result.size,Image.Resampling.LANCZOS),result,config['strength'])
    if alpha is not None:result.putalpha(alpha.resize(result.size,Image.Resampling.LANCZOS))
    emit(progress=93,message='Saving full-resolution result')
    np.save(config['output'],np.asarray(result),allow_pickle=False)
    emit(progress=95,message='GPU complete',result={**device,'seconds':round(time.perf_counter()-started,3),'peak_vram_gib':round(torch.cuda.max_memory_allocated()/2**30,3),'parameters':sum(p.numel() for p in net.parameters()),'input_size':[w,h],'output_size':list(result.size),'tile_padding':pad})

if __name__=='__main__':
    try:
        if sys.argv[1]=='--probe':emit(**probe())
        else:run(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as error:emit(error=str(error));sys.exit(1)
