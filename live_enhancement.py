"""Serve the already-installed, hash-verified FSRCNN weights for local WebGPU."""
import hashlib
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
import science

router=APIRouter(prefix='/api/live-enhancement')
MODEL=Path(__file__).parent/'models'/'FSRCNN_x2.pb'

def fields(data):
    """Read the protobuf wire fields in this pinned GraphDef; no TensorFlow install."""
    pos=0
    def varint():
        nonlocal pos
        value=0
        for shift in range(0,70,7):
            if pos>=len(data):raise ValueError('Truncated model.')
            byte=data[pos];pos+=1;value|=(byte&127)<<shift
            if not byte&128:return value
        raise ValueError('Invalid model integer.')
    while pos<len(data):
        tag=varint();number,wire=tag>>3,tag&7
        if wire==0:yield number,varint();continue
        length={1:8,5:4}.get(wire)
        if wire==2:length=varint()
        if length is None or pos+length>len(data):raise ValueError('Invalid model field.')
        value=data[pos:pos+length];pos+=length
        yield number,value

def constants(raw):
    result={}
    for number,node in fields(raw):
        if number!=1:continue
        parts=list(fields(node));name=next(v.decode() for k,v in parts if k==1)
        if next(v for k,v in parts if k==2)!=b'Const':continue
        for key,entry in parts:
            if key!=5:continue
            attr=dict(fields(entry))
            if attr.get(1)!=b'value':continue
            tensor=dict(fields(dict(fields(attr[2]))[8]))
            if tensor.get(1)!=1:continue
            shape=[dict(fields(dim))[1] for k,dim in fields(tensor.get(2,b'')) if k==2]
            value=tensor.get(4,tensor.get(5,b''))
            array=np.frombuffer(value,dtype='<f4').copy()
            if array.size==1 and np.prod(shape)>1:array=np.full(shape,array[0],dtype=np.float32)
            result[name]=array.reshape(shape)
    return result

@lru_cache(maxsize=1)
def model_weights():
    raw=MODEL.read_bytes()
    digest=hashlib.sha256(raw).hexdigest()
    if digest!=science.MODEL_SHA:raise ValueError('The local FSRCNN model checksum does not match. Run Setup.cmd.')
    tensors=constants(raw);layers=[]
    expected=[(5,1,56),(1,56,12),*( [(3,12,12)]*4 ),(1,12,56),(1,56,4)]
    for i,(kernel,inputs,outputs) in enumerate(expected,1):
        weights=tensors[f'f{i}']
        if weights.shape!=(kernel,kernel,inputs,outputs):raise ValueError('Unexpected model dimensions.')
        layers.append({'kernel':kernel,'inputs':inputs,'outputs':outputs,
            'weights':weights.transpose(3,2,0,1).ravel().tolist(),
            'bias':tensors[f'b{i}'].ravel().tolist() if i<8 else [0.]*outputs,
            'alpha':tensors[f'alpha{i}'].ravel().tolist() if i<8 else [1.]*outputs})
    return {'schema':1,'name':'FSRCNN 2×','sha256':digest,'scale':2,'halo':6,
        'output_bias':float(tensors['b8'].ravel()[0]),'layers':layers,
        'license':'Apache-2.0','source':'https://github.com/Saafke/FSRCNN_Tensorflow',
        'processing':'Local WebGPU neural luminance upscaling. Visualization only, not new measurements.'}

@router.get('/model')
def model():
    try:return model_weights()
    except (OSError,ValueError,KeyError) as error:raise HTTPException(503,str(error)) from None
