"""Small, local image-derived astronomy scenes, exported as portable glTF 2 GLB.

Depth here is a display heuristic, never a distance measurement. The original
photograph is untouched. A relief and a few isolated star cards give a gentle
parallax view of the front of the photograph, not a reconstructed hidden side.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from scipy.ndimage import gaussian_filter, maximum_filter, zoom


MAX_PIXELS = 25_000_000
MAX_INPUT_BYTES = 128 * 1024 * 1024
TEXTURE_EDGE = 1024
GRID_EDGE = 129
MAX_STARS = 128
CAMERA_DISTANCE = 3.4
ALGORITHM = "astronomy-parallax-relief-v1"
INTERPRETATION = (
    "Interpreted 3D visualization. Image brightness and a seeded display pattern "
    "suggest depth; they do not measure astronomical distances or reconstruct "
    "the hidden side. Best viewed with gentle rotation from the front."
)


def _linear(rgb):
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def _srgb(rgb):
    rgb = np.clip(rgb, 0, 1)
    return np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - 0.055)


def _png(array):
    stream = io.BytesIO()
    Image.fromarray(array).save(stream, format="PNG", optimize=False)
    return stream.getvalue()


def _read_image(path):
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("The image file must be smaller than 128 MB.")
    raw = path.read_bytes()
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            if opened.format not in {"PNG", "JPEG"}:
                raise ValueError("Choose a PNG or JPEG display image for the 3D scene.")
            w, h = opened.size
            if min(w, h) < 2 or w * h > MAX_PIXELS:
                raise ValueError("The image must have at least two pixels per side and at most 25 million pixels.")
            if getattr(opened, "is_animated", False):
                raise ValueError("Choose a still PNG or JPEG image.")
            oriented = ImageOps.exif_transpose(opened)
            original_size = oriented.size
            # Transparent exported sky frames have a black sky behind them.
            rgba = oriented.convert("RGBA")
            image = Image.new("RGB", rgba.size, (0, 0, 0))
            image.paste(rgba, mask=rgba.getchannel("A"))
            image.thumbnail((TEXTURE_EDGE, TEXTURE_EDGE), Image.Resampling.LANCZOS)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("The source is not a readable PNG or JPEG image.") from exc
    return image, original_size, hashlib.sha256(raw).hexdigest()


def _star_layers(rgb):
    """Separate compact peaks without inventing stars or changing their colors.

    Background + RGBA card reconstructs the source in linear color, apart from
    PNG quantization. Extended nebulosity stays on the continuous relief.
    """
    h, w, _ = rgb.shape
    base = _linear(rgb).copy()
    if min(w, h) < 48:
        return base, []
    luminance = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    sharp = gaussian_filter(luminance, 0.65) - gaussian_filter(luminance, 3.0)
    threshold = max(0.045, float(np.percentile(sharp, 99.65)))
    peaks = (sharp == maximum_filter(sharp, size=7)) & (sharp > threshold) & (luminance > 0.3)
    rows, cols = np.where(peaks)
    order = np.argsort(-sharp[rows, cols], kind="stable")
    smooth = gaussian_filter(base, sigma=(4.0, 4.0, 0))
    stars = []
    for index in order:
        y, x = int(rows[index]), int(cols[index])
        if min(x, y, w - 1 - x, h - 1 - y) < 12:
            continue
        # Broad bright cores are galaxies/clouds, not detached point sources.
        core = np.maximum(sharp[y - 5:y + 6, x - 5:x + 6], 0)
        yy, xx = np.mgrid[-5:6, -5:6]
        variance = float(np.sum(core * (xx * xx + yy * yy)) / max(float(core.sum()), 1e-8))
        if variance > 9.0:
            continue
        radius = int(np.clip(math.ceil(math.sqrt(variance) * 2.1), 4, 10))
        if any(abs(x - star["x"]) < radius + star["radius"] + 2 and
               abs(y - star["y"]) < radius + star["radius"] + 2 for star in stars):
            continue
        section = np.s_[y - radius:y + radius + 1, x - radius:x + radius + 1]
        original = base[section].copy()
        yy, xx = np.mgrid[-radius:radius + 1, -radius:radius + 1]
        distance = np.sqrt(xx * xx + yy * yy) / radius
        mask = np.clip((1 - distance) / 0.45, 0, 1)
        mask = mask * mask * (3 - 2 * mask)
        background = original * (1 - mask[..., None]) + smooth[section] * mask[..., None]
        difference = original - background
        minimum_alpha = np.where(difference >= 0,
                                 difference / np.maximum(1 - background, 1e-7),
                                 -difference / np.maximum(background, 1e-7))
        alpha = np.clip(np.max(minimum_alpha, axis=2) * 1.015, 0, 1)
        color = background + difference / np.maximum(alpha[..., None], 1e-7)
        patch = np.dstack((_srgb(color), alpha))
        base[section] = background
        stars.append({"x": x, "y": y, "radius": radius, "patch": patch})
        if len(stars) >= MAX_STARS:
            break
    return base, stars


def _relief(base, depth, seed):
    h, w, _ = base.shape
    cols = max(2, round((GRID_EDGE - 1) * w / max(w, h)) + 1)
    rows = max(2, round((GRID_EDGE - 1) * h / max(w, h)) + 1)
    luminance = base @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    luminance = gaussian_filter(luminance, max(w, h) / 65)
    values = np.asarray(Image.fromarray(luminance).resize((cols, rows), Image.Resampling.BILINEAR))
    low, high = np.percentile(values, [5, 98])
    if high - low < 1e-6:
        z = np.zeros((rows, cols), np.float32)
    else:
        intensity = np.clip((values - low) / (high - low), 0, 1) ** 0.65
        rng = np.random.default_rng(seed)
        noise = gaussian_filter(rng.uniform(-1, 1, (17, 17)), 1.2)
        noise = zoom(noise, (rows / 17, cols / 17), order=3)[:rows, :cols]
        noise /= max(float(np.max(np.abs(noise))), 1e-6)
        z = ((intensity - 0.5) * 0.72 + noise * intensity * 0.1) * depth
    width, height = 2 * w / max(w, h), 2 * h / max(w, h)
    xx, yy = np.meshgrid(np.linspace(-width / 2, width / 2, cols),
                         np.linspace(height / 2, -height / 2, rows))
    # A frontal camera at the suggested position sees the source framing.
    correction = 1 - z / CAMERA_DISTANCE
    positions = np.dstack((xx * correction, yy * correction, z)).astype("<f4")
    across = np.gradient(positions, axis=1)
    down = np.gradient(positions, axis=0)
    normals = np.cross(down, across)
    normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-8)
    uu, vv = np.meshgrid(np.linspace(0, 1, cols), np.linspace(0, 1, rows))
    uv = np.dstack((uu, vv)).astype("<f4")
    cells = np.arange(rows * cols, dtype=np.uint32).reshape(rows, cols)[:-1, :-1].ravel()
    indices = np.column_stack((cells, cells + cols, cells + 1,
                               cells + 1, cells + cols, cells + cols + 1)).astype("<u4").ravel()
    return positions.reshape(-1, 3), normals.reshape(-1, 3), uv.reshape(-1, 2), indices, z


class _GLB:
    def __init__(self, metadata):
        self.binary = bytearray()
        self.document = {
            "asset": {"version": "2.0", "generator": "Universe Explorer local astronomy scene"},
            "extensionsUsed": ["KHR_materials_unlit"],
            "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [],
            "materials": [], "textures": [], "images": [],
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
            "bufferViews": [], "accessors": [], "extras": metadata,
        }

    def view(self, data, target=None):
        self.binary.extend(b"\0" * (-len(self.binary) % 4))
        entry = {"buffer": 0, "byteOffset": len(self.binary), "byteLength": len(data)}
        if target is not None:
            entry["target"] = target
        self.binary.extend(data)
        self.document["bufferViews"].append(entry)
        return len(self.document["bufferViews"]) - 1

    def accessor(self, values, kind, index=False):
        values = np.ascontiguousarray(values, dtype="<u4" if index else "<f4")
        entry = {"bufferView": self.view(values.tobytes(), 34963 if index else 34962),
                 "componentType": 5125 if index else 5126, "count": len(values), "type": kind}
        if not index:
            entry["min"] = values.min(axis=0).tolist()
            entry["max"] = values.max(axis=0).tolist()
        self.document["accessors"].append(entry)
        return len(self.document["accessors"]) - 1

    def texture(self, png, name, transparent=False):
        image_index = len(self.document["images"])
        self.document["images"].append({"name": name, "bufferView": self.view(png), "mimeType": "image/png"})
        self.document["textures"].append({"source": image_index, "sampler": 0})
        self.document["materials"].append({
            "name": name, "extensions": {"KHR_materials_unlit": {}},
            "pbrMetallicRoughness": {"baseColorTexture": {"index": image_index}, "metallicFactor": 0, "roughnessFactor": 1},
            "alphaMode": "BLEND" if transparent else "OPAQUE", "doubleSided": True,
        })
        return len(self.document["materials"]) - 1

    def mesh(self, name, positions, normals, uv, indices, material):
        attributes = {"POSITION": self.accessor(positions, "VEC3"),
                      "NORMAL": self.accessor(normals, "VEC3"), "TEXCOORD_0": self.accessor(uv, "VEC2")}
        mesh = {"name": name, "primitives": [{"attributes": attributes, "indices": self.accessor(indices, "SCALAR", True),
                                                 "material": material, "mode": 4}]}
        self.document["meshes"].append(mesh)
        self.document["nodes"].append({"name": name, "mesh": len(self.document["meshes"]) - 1})
        self.document["scenes"][0]["nodes"].append(len(self.document["nodes"]) - 1)

    def save(self, path):
        self.document["buffers"] = [{"byteLength": len(self.binary)}]
        encoded = json.dumps(self.document, separators=(",", ":"), allow_nan=False).encode("utf-8")
        encoded += b" " * (-len(encoded) % 4)
        binary = bytes(self.binary) + b"\0" * (-len(self.binary) % 4)
        content = (struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(encoded) + 8 + len(binary)) +
                   struct.pack("<I4s", len(encoded), b"JSON") + encoded +
                   struct.pack("<I4s", len(binary), b"BIN\0") + binary)
        path.write_bytes(content)


def generate_scene(input_path: Path, output_dir: Path, *, depth: float = 0.35, seed: int = 0) -> dict:
    """Generate a bounded, deterministic, self-contained image-derived scene.

    Only output_dir is written. PNG/JPEG sources remain byte-for-byte intact.
    ``depth`` is an artistic strength in [0, 1], not a physical distance.
    """
    if isinstance(depth, bool) or not isinstance(depth, (int, float)) or not math.isfinite(depth) or not 0 <= depth <= 1:
        raise ValueError("Depth must be a finite number from 0 to 1.")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise ValueError("Seed must be an integer from 0 to 4294967295.")
    input_path, output_dir = Path(input_path), Path(output_dir)
    for name in ("scene.glb", "preview.png"):
        if (output_dir / name).resolve() == input_path.resolve():
            raise ValueError("Choose an output directory that does not overwrite the source image.")
    image, original_size, digest = _read_image(input_path)
    rgb = np.asarray(image, dtype=np.float32) / 255
    base, stars = _star_layers(rgb)
    if depth == 0:
        base, stars = _linear(rgb), []
    positions, normals, uv, indices, height_map = _relief(base, float(depth), seed)
    metadata = {
        "kind": "interpreted-astronomy-scene", "scientific": False, "ai_generated": False,
        "interpretation": INTERPRETATION, "source_sha256": digest,
        "source_dimensions": list(original_size), "texture_dimensions": list(image.size),
        "algorithm": ALGORITHM, "settings": {"depth": float(depth), "seed": seed},
        "recommended_camera": {"position": [0, 0, CAMERA_DISTANCE], "target": [0, 0, 0],
                               "fov_degrees": 40, "near": 0.01, "far": 100},
        "viewing": {"front_axis": "+Z", "up_axis": "+Y", "suggested_max_front_orbit_degrees": 65,
                    "has_reconstructed_backside": False},
        "preview_description": "Source photograph after orientation and bounded resizing; not a 3D render.",
    }
    glb = _GLB(metadata)
    material = glb.texture(_png(np.round(_srgb(base) * 255).astype(np.uint8)), "Source-colored relief")
    glb.mesh("Image relief", positions, normals, uv, indices, material)
    star_vertices = 0
    if stars:
        tile = 32
        atlas_cols = min(16, len(stars))
        atlas_rows = math.ceil(len(stars) / atlas_cols)
        atlas = np.zeros((atlas_rows * tile, atlas_cols * tile, 4), np.uint8)
        points, star_uv, faces = [], [], []
        h, w = rgb.shape[:2]
        width, height = 2 * w / max(w, h), 2 * h / max(w, h)
        rng = np.random.default_rng(seed)
        for i, star in enumerate(stars):
            patch = np.round(np.clip(star["patch"], 0, 1) * 255).astype(np.uint8)
            size = patch.shape[0]
            tx, ty = (i % atlas_cols) * tile + 2, (i // atlas_cols) * tile + 2
            atlas[ty:ty + size, tx:tx + size] = patch
            x, y, radius = star["x"], star["y"], star["radius"]
            gx = round(x / max(w - 1, 1) * (height_map.shape[1] - 1))
            gy = round(y / max(h - 1, 1) * (height_map.shape[0] - 1))
            z = float(height_map[gy, gx]) + depth * float(rng.uniform(0.10, 0.30))
            correction = 1 - z / CAMERA_DISTANCE
            left = ((x - radius) / w - 0.5) * width * correction
            right = ((x + radius + 1) / w - 0.5) * width * correction
            top = (0.5 - (y - radius) / h) * height * correction
            bottom = (0.5 - (y + radius + 1) / h) * height * correction
            points.extend(((left, top, z), (left, bottom, z), (right, top, z), (right, bottom, z)))
            u0, u1 = tx / atlas.shape[1], (tx + size) / atlas.shape[1]
            v0, v1 = ty / atlas.shape[0], (ty + size) / atlas.shape[0]
            star_uv.extend(((u0, v0), (u0, v1), (u1, v0), (u1, v1)))
            offset = i * 4
            faces.extend((offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3))
        star_vertices = len(points)
        material = glb.texture(_png(atlas), "Source star colors and transparency", True)
        glb.mesh("Isolated source stars", np.asarray(points), np.tile([0, 0, 1], (len(points), 1)),
                 np.asarray(star_uv), np.asarray(faces, dtype=np.uint32), material)
    stats = {"vertices": len(positions) + star_vertices, "triangles": len(indices) // 3 + len(stars) * 2,
             "star_layers": len(stars), "texture_width": image.width, "texture_height": image.height,
             "source_width": original_size[0], "source_height": original_size[1]}
    metadata["stats"] = stats
    output_dir.mkdir(parents=True, exist_ok=True)
    glb.save(output_dir / "scene.glb")
    image.save(output_dir / "preview.png", format="PNG")
    return {"model_file": "scene.glb", "preview_file": "preview.png", "stats": stats,
            "processing": {"algorithm": ALGORITHM, "local": True, "scientific": False,
                           "ai_generated": False, "interpretation": INTERPRETATION,
                           "source_sha256": digest, "depth": float(depth), "seed": seed}}
