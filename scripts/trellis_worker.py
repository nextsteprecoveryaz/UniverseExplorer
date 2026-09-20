"""Isolated Linux worker for local TRELLIS.2 inference; stdout is JSON Lines.

The FastAPI process invokes this with a fixed argv through WSL. The image stays
on this computer. No background removal is applied to astronomical photographs.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import threading
import time
import traceback

PROTOCOL = sys.stdout

def progress(message: str, **details):
    print(json.dumps({"progress": message, **details}), file=PROTOCOL, flush=True)


def watch_cancellation(marker: Path | None, heartbeat: Path | None):
    if marker is None and heartbeat is None:
        return
    started = time.time()
    while True:
        cancelled = marker is not None and marker.exists()
        if heartbeat is not None:
            try:
                last_alive = heartbeat.stat().st_mtime
            except FileNotFoundError:
                last_alive = started
            cancelled = cancelled or time.time() - last_alive > 45
        if cancelled:
            try:
                progress("Cancelled", cancelled=True)
            finally:
                # This process exclusively owns this job's CUDA context.
                os._exit(130)
        time.sleep(0.25)


def load_pipeline(resolution: int):
    from huggingface_hub import hf_hub_download
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    from trellis2.pipelines.base import Pipeline
    from trellis2.pipelines import samplers
    from trellis2.modules import image_feature_extractor

    model = "microsoft/TRELLIS.2-4B"
    config = json.loads(Path(hf_hub_download(model, "pipeline.json")).read_text())["args"]
    # Check permission/download the feature extractor before allocating all 3D
    # models. It is an official gated dependency, so account access is required.
    progress("Loading the image feature model")
    conditioning = image_feature_extractor.DinoV3FeatureExtractor(
        **config["image_cond_model"]["args"]
    )

    class ImagePipeline(Trellis2ImageTo3DPipeline):
        model_names_to_load = [
            name for name in Trellis2ImageTo3DPipeline.model_names_to_load
            if resolution != 512 or not name.endswith("_1024")
        ]

    progress("Loading TRELLIS.2 shape and material models")
    base = Pipeline.from_pretrained.__func__(ImagePipeline, model)
    kwargs = {name: config[name] for name in (
        "sparse_structure_sampler_params", "shape_slat_sampler_params",
        "tex_slat_sampler_params", "shape_slat_normalization", "tex_slat_normalization"
    ) if name in config}
    for prefix in ("sparse_structure", "shape_slat", "tex_slat"):
        item = config[prefix + "_sampler"]
        kwargs[prefix + "_sampler"] = getattr(samplers, item["name"])(**item["args"])
        kwargs[prefix + "_sampler_params"] = item["params"]
    pipeline = ImagePipeline(
        models=base.models, image_cond_model=conditioning, rembg_model=None,
        low_vram=True, default_pipeline_type="512" if resolution == 512 else "1024_cascade",
        **kwargs,
    )
    pipeline.cuda()
    return pipeline


def run(args):
    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / "data" / "trellis-runtime.json").read_text(encoding="utf-8-sig"))
    repository = Path(config["repository"]).resolve()
    if not (repository / "trellis2" / "pipelines").is_dir():
        raise RuntimeError("TRELLIS.2 source is not installed. Run scripts/setup-trellis.ps1.")
    os.environ.setdefault("ATTN_BACKEND", "xformers")
    os.environ.setdefault("SPARSE_ATTN_BACKEND", "xformers")
    os.environ.setdefault("CUDA_HOME", "/usr/local/cuda-12.8")
    os.environ.setdefault("TORCH_CUDA_ARCH_LIST", "12.0")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    os.environ.setdefault("HF_HOME", str(repository.parent / "huggingface"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    # Reuse the user's existing local login; never serialize or print the token.
    token_path = root.parent / ".cache" / "huggingface" / "token"
    if token_path.is_file():
        os.environ.setdefault("HF_TOKEN_PATH", str(token_path))
    sys.path.insert(0, str(repository))
    os.chdir(repository)
    threading.Thread(target=watch_cancellation, args=(args.cancel_file, args.heartbeat_file), daemon=True).start()
    started = time.monotonic()
    progress("Starting local TRELLIS.2", resolution=args.resolution)
    # Third-party diagnostics belong on stderr, keeping our protocol parseable.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from xformers.ops.fmha.dispatch import _set_use_fa3
        from PIL import Image, ImageOps
        if not torch.cuda.is_available():
            raise RuntimeError("The local NVIDIA GPU is unavailable in WSL.")
        # xformers 0.0.31 incorrectly considers Blackwell eligible for its
        # Hopper-only FA3 kernel. Its FA2/CUTLASS dispatch works on SM120.
        if torch.cuda.get_device_capability()[0] >= 12:
            _set_use_fa3(False)
        image = ImageOps.exif_transpose(Image.open(args.input)).convert("RGB")
        side = min(1600, max(image.size))
        image = ImageOps.pad(image, (side, side), method=Image.Resampling.LANCZOS, color="black")
        pipeline = load_pipeline(args.resolution)
        stages = {
            "get_cond": "Reading the image",
            "sample_sparse_structure": "Generating the 3D structure",
            "sample_shape_slat": "Generating surface geometry",
            "sample_shape_slat_cascade": "Refining surface geometry",
            "sample_tex_slat": "Generating surface colors and materials",
            "decode_shape_slat": "Building the mesh",
            "decode_tex_slat": "Building the texture",
        }
        for method, label in stages.items():
            original = getattr(pipeline, method)
            def wrapped(*a, _method=original, _label=label, **kw):
                progress(_label)
                return _method(*a, **kw)
            setattr(pipeline, method, wrapped)
        mesh = pipeline.run(image, seed=args.seed, preprocess_image=False,
                            pipeline_type="512" if args.resolution == 512 else "1024_cascade")[0]
        progress("Preparing the downloadable textured model")
        mesh.simplify(16777216)
        import o_voxel
        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
            coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=150000, texture_size=2048, remesh=True,
            remesh_band=1, remesh_project=0, verbose=True,
        )
        glb.metadata.update({
            "source_input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
            "model": "microsoft/TRELLIS.2-4B", "seed": args.seed,
            "resolution": args.resolution, "local": True,
            "interpretation": "AI-interpreted 3D visualization; geometry and unseen surfaces are inferred, not measured.",
            "scientific_evidence": False,
        })
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".partial.glb")
        glb.export(str(temporary))
    with temporary.open("rb") as handle:
        header = handle.read(12)
    if len(header) != 12 or struct.unpack("<4sII", header) != (b"glTF", 2, temporary.stat().st_size):
        raise RuntimeError("The generated model failed GLB validation.")
    temporary.replace(args.output)
    progress("3D model ready", complete=True, elapsed_seconds=round(time.monotonic() - started, 1),
             bytes=args.output.stat().st_size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--resolution", type=int, choices=(512, 1024), default=512)
    parser.add_argument("--cancel-file", type=Path)
    parser.add_argument("--heartbeat-file", type=Path)
    options = parser.parse_args()
    try:
        run(options)
    except Exception as error:
        message = str(error)
        if "gated" in message.lower() or "403" in message or "401" in message:
            message = "The local Hugging Face account needs access to facebook/dinov3-vitl16-pretrain-lvd1689m. Open that model page and request access."
        progress("TRELLIS.2 could not finish", error=message[:1500])
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
