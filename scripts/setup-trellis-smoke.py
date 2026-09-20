"""Exercise local CUDA attention, sparse convolution and textured GLB export.

This synthetic geometry test requires no gated model. It does not mark the
image-to-3D runtime ready: that requires setup-trellis-verify.py to pass.
"""
import json
import os
from pathlib import Path
import struct
import sys

root = Path(__file__).resolve().parents[1]
config = json.loads((root / 'data' / 'trellis-runtime.json').read_text(encoding='utf-8-sig'))
os.environ.setdefault('CUDA_HOME', '/usr/local/cuda-12.8')
os.environ.setdefault('TORCH_CUDA_ARCH_LIST', '12.0')
os.environ.setdefault('ATTN_BACKEND', 'xformers')
sys.path.insert(0, config['repository'])
import torch
import xformers.ops as x
from xformers.ops.fmha.dispatch import _set_use_fa3
import trimesh
import o_voxel
from flex_gemm.ops.spconv import sparse_submanifold_conv3d
from trellis2.pipelines import Trellis2ImageTo3DPipeline

_set_use_fa3(False)
q = torch.randn(1, 1024, 16, 64, device='cuda', dtype=torch.float16)
assert torch.isfinite(x.memory_efficient_attention(q, q, q)).all()
mask = x.fmha.BlockDiagonalMask.from_seqlens([512, 512])
assert torch.isfinite(x.memory_efficient_attention(q, q, q, attn_bias=mask)).all()
print('Dense and sparse CUDA attention passed.', flush=True)

coords = torch.cartesian_prod(torch.arange(1), torch.arange(4), torch.arange(4), torch.arange(4)).int().cuda()
features = torch.ones((len(coords), 32), dtype=torch.float16, device='cuda')
weights = torch.ones((32, 3, 3, 3, 32), dtype=torch.float16, device='cuda')
result, _ = sparse_submanifold_conv3d(features, coords, torch.Size([1, 32, 4, 4, 4]), weights)
assert result.shape == features.shape and torch.isfinite(result).all()
# Each corner has exactly eight neighbors, each contributing 32 unit channels.
assert float(result[0, 0]) == 256
print('Sparse CUDA convolution passed.', flush=True)

sphere = trimesh.creation.icosphere(subdivisions=2, radius=0.32)
vertices = torch.tensor(sphere.vertices, dtype=torch.float32, device='cuda')
faces = torch.tensor(sphere.faces, dtype=torch.int32, device='cuda')
xyz = torch.cartesian_prod(torch.arange(32), torch.arange(32), torch.arange(32)).int().cuda()
attributes = torch.cat([xyz.float() / 31, torch.zeros((len(xyz), 1), device='cuda'),
                        torch.ones((len(xyz), 2), device='cuda')], dim=1)
mesh = o_voxel.postprocess.to_glb(
    vertices=vertices, faces=faces, attr_volume=attributes, coords=xyz,
    attr_layout={'base_color': slice(0, 3), 'metallic': slice(3, 4),
                 'roughness': slice(4, 5), 'alpha': slice(5, 6)},
    aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]], voxel_size=1 / 32,
    decimation_target=2000, texture_size=256, remesh=True, verbose=True,
)
output = root / 'data' / 'trellis-verification' / 'native-smoke.glb'
output.parent.mkdir(parents=True, exist_ok=True)
mesh.metadata.update({'local': True, 'scientific_evidence': False, 'test_geometry': True})
mesh.export(str(output))
with output.open('rb') as handle:
    magic, version, size = struct.unpack('<4sII', handle.read(12))
    count, kind = struct.unpack('<I4s', handle.read(8))
    document = json.loads(handle.read(count))
assert magic == b'glTF' and version == 2 and size == output.stat().st_size
assert document['meshes'] and document['images'] and document['materials']
assert any(item.get('extras', {}).get('scientific_evidence') is False for item in document['meshes'])
report = {'gpu': torch.cuda.get_device_name(), 'torch': torch.__version__,
          'capability': list(torch.cuda.get_device_capability()),
          'attention': 'passed', 'sparse_convolution': 'passed',
          'textured_glb_export': 'passed', 'glb_bytes': size,
          'note': 'Synthetic geometry test; image-to-3D model verification remains separate.'}
(output.parent / 'native-smoke.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report), flush=True)
