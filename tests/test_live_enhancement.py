import hashlib
import numpy as np
import pytest
import cv2
from fastapi.testclient import TestClient

from app import app
import live_enhancement as le
import science


def test_serves_only_verified_existing_model():
    model=le.model_weights()
    assert model['sha256']==science.MODEL_SHA==hashlib.sha256(le.MODEL.read_bytes()).hexdigest()
    assert model['scale']==2 and model['halo']==6
    assert [(v['kernel'],v['inputs'],v['outputs']) for v in model['layers']]==[(5,1,56),(1,56,12),*[(3,12,12)]*4,(1,12,56),(1,56,4)]
    assert all(np.isfinite(layer['weights']).all() for layer in model['layers'])
    # OpenCV independently decodes the TensorFlow kernels and PReLU constants.
    net=cv2.dnn.readNetFromTensorflow(str(le.MODEL))
    for i,layer in enumerate(model['layers']):
        weights=net.getLayer(net.getLayerId(f'conv{i+1}')).blobs[0]
        np.testing.assert_array_equal(np.array(layer['weights'],dtype=np.float32),weights.ravel())
        if i<7:
            bias=net.getLayer(net.getLayerId('add'+(f'_{i*2}' if i else ''))).blobs[0]
            slope=net.getLayer(net.getLayerId('mul'+(f'_{i*2}' if i else ''))).blobs[0]
            np.testing.assert_array_equal(layer['bias'],bias.ravel())
            np.testing.assert_array_equal(layer['alpha'],slope.ravel())
    with TestClient(app) as client:
        response=client.get('/api/live-enhancement/model')
        assert response.status_code==200 and response.json()['sha256']==science.MODEL_SHA


def test_changed_or_missing_model_fails_without_fetching(monkeypatch,tmp_path):
    path=tmp_path/'model.pb';path.write_bytes(b'changed')
    monkeypatch.setattr(le,'MODEL',path);le.model_weights.cache_clear()
    try:
        with pytest.raises(ValueError,match='checksum'):le.model_weights()
        path.unlink()
        with TestClient(app) as client:assert client.get('/api/live-enhancement/model').status_code==503
    finally:le.model_weights.cache_clear()


def test_invalid_protobuf_is_rejected():
    for raw in [b'\x12\xff',b'\x12\x08x',b'\x0f']:
        with pytest.raises(ValueError):list(le.fields(raw))
