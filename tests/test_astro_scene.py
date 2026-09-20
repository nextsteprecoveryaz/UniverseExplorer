import hashlib
import io
import json
import struct

import numpy as np
import pytest
from PIL import Image

import astro_scene


def read_glb(path):
    data = path.read_bytes()
    magic, version, size = struct.unpack_from("<III", data)
    assert magic == 0x46546C67 and version == 2 and size == len(data)
    json_size, chunk_type = struct.unpack_from("<I4s", data, 12)
    assert chunk_type == b"JSON" and json_size % 4 == 0
    document = json.loads(data[20:20 + json_size])
    binary_size, chunk_type = struct.unpack_from("<I4s", data, 20 + json_size)
    assert chunk_type == b"BIN\0" and binary_size % 4 == 0
    binary = data[28 + json_size:]
    assert binary_size == len(binary)
    assert 0 <= len(binary) - document["buffers"][0]["byteLength"] <= 3
    return document, binary


def accessor(document, binary, index):
    item = document["accessors"][index]
    view = document["bufferViews"][item["bufferView"]]
    dimensions = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[item["type"]]
    dtype = {5125: "<u4", 5126: "<f4"}[item["componentType"]]
    return np.frombuffer(binary, dtype=dtype, offset=view["byteOffset"],
                         count=item["count"] * dimensions).reshape(item["count"], dimensions)


def embedded_image(document, binary, index):
    image = document["images"][index]
    assert image["mimeType"] == "image/png" and "uri" not in image
    view = document["bufferViews"][image["bufferView"]]
    return Image.open(io.BytesIO(binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]))


@pytest.fixture
def source(tmp_path):
    y, x = np.mgrid[:180, :240]
    cloud = np.exp(-((x - 110) ** 2 / 1600 + (y - 92) ** 2 / 700))
    rgb = np.stack((cloud * 0.58, cloud * 0.25, cloud * 0.72), axis=-1) + 0.015
    for px, py in [(35, 35), (190, 70), (40, 145), (180, 145)]:
        star = np.exp(-((x - px) ** 2 + (y - py) ** 2) / 2.5)
        rgb += star[..., None] * 0.92
    file = tmp_path / "nebula.png"
    Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(file)
    return file


def test_portable_glb_geometry_textures_and_provenance(source, tmp_path):
    original = source.read_bytes()
    result = astro_scene.generate_scene(source, tmp_path / "result")
    document, binary = read_glb(tmp_path / "result" / result["model_file"])
    assert result["stats"]["star_layers"] == 4
    assert result["stats"]["vertices"] <= 129 * 129 + 128 * 4
    assert result["stats"]["triangles"] <= 128 * 128 * 2 + 128 * 2
    for view in document["bufferViews"]:
        assert view["byteOffset"] % 4 == 0
        assert view["byteOffset"] + view["byteLength"] <= len(binary)
        assert view["buffer"] == 0
    for mesh in document["meshes"]:
        primitive = mesh["primitives"][0]
        p = accessor(document, binary, primitive["attributes"]["POSITION"])
        n = accessor(document, binary, primitive["attributes"]["NORMAL"])
        uv = accessor(document, binary, primitive["attributes"]["TEXCOORD_0"])
        indices = accessor(document, binary, primitive["indices"]).ravel()
        assert np.isfinite(p).all() and np.isfinite(n).all() and np.isfinite(uv).all()
        assert len(p) == len(n) == len(uv)
        assert 0 <= indices.min() <= indices.max() < len(p)
        assert len(indices) % 3 == 0
        assert np.allclose(np.linalg.norm(n, axis=1), 1, atol=1e-5)
        assert (n[:, 2] > 0).all()
        assert (uv >= 0).all() and (uv <= 1).all()
        triangles = p[indices.reshape(-1, 3)]
        assert (np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])[:, 2] > 0).all()
    assert len(document["images"]) == 2
    assert embedded_image(document, binary, 0).size == (240, 180)
    assert embedded_image(document, binary, 1).mode == "RGBA"
    assert document["materials"][1]["alphaMode"] == "BLEND"
    assert all("KHR_materials_unlit" in material["extensions"] for material in document["materials"])
    assert document["extras"]["source_sha256"] == hashlib.sha256(original).hexdigest()
    assert document["extras"]["scientific"] is False
    assert document["extras"]["ai_generated"] is False
    assert document["extras"]["viewing"]["has_reconstructed_backside"] is False
    assert "do not measure" in document["extras"]["interpretation"]
    assert source.read_bytes() == original
    assert set(p.name for p in (tmp_path / "result").iterdir()) == {"scene.glb", "preview.png"}


def test_seed_is_reproducible_and_affects_only_interpreted_geometry(source, tmp_path):
    for name, seed in [("a", 1), ("b", 1), ("c", 2)]:
        astro_scene.generate_scene(source, tmp_path / name, seed=seed)
    assert (tmp_path / "a/scene.glb").read_bytes() == (tmp_path / "b/scene.glb").read_bytes()
    doc_a, bin_a = read_glb(tmp_path / "a/scene.glb")
    doc_c, bin_c = read_glb(tmp_path / "c/scene.glb")
    assert not np.array_equal(accessor(doc_a, bin_a, 0), accessor(doc_c, bin_c, 0))
    assert np.array_equal(embedded_image(doc_a, bin_a, 0), embedded_image(doc_c, bin_c, 0))
    assert (tmp_path / "a/preview.png").read_bytes() == (tmp_path / "c/preview.png").read_bytes()


def test_zero_depth_preserves_pixels_orientation_uvs_and_front_framing(tmp_path):
    rgb = np.zeros((60, 80, 3), np.uint8)
    rgb[:30, :40] = (255, 0, 0)
    rgb[:30, 40:] = (0, 255, 0)
    rgb[30:, :40] = (0, 0, 255)
    rgb[30:, 40:] = (255, 255, 0)
    path = tmp_path / "corners.png"
    Image.fromarray(rgb).save(path)
    result = astro_scene.generate_scene(path, tmp_path / "scene", depth=0)
    document, binary = read_glb(tmp_path / "scene/scene.glb")
    assert result["stats"]["star_layers"] == 0
    assert np.array_equal(embedded_image(document, binary, 0), rgb)
    p, uv = accessor(document, binary, 0), accessor(document, binary, 2)
    assert np.all(p[:, 2] == 0)
    assert np.allclose(p[0], [-1, 0.75, 0]) and np.allclose(uv[0], [0, 0])
    assert np.allclose(p[-1], [1, -0.75, 0]) and np.allclose(uv[-1], [1, 1])


def test_relief_front_projection_maintains_photo_framing(source, tmp_path):
    astro_scene.generate_scene(source, tmp_path / "scene", depth=1)
    document, binary = read_glb(tmp_path / "scene/scene.glb")
    p, uv = accessor(document, binary, 0), accessor(document, binary, 2)
    corrected = p[:, :2] / (1 - p[:, 2:3] / astro_scene.CAMERA_DISTANCE)
    assert np.allclose(corrected[:, 0], (uv[:, 0] - 0.5) * 2, atol=1e-6)
    assert np.allclose(corrected[:, 1], (0.5 - uv[:, 1]) * 1.5, atol=1e-6)


def test_star_decomposition_keeps_linear_source_colors(source):
    rgb = np.asarray(Image.open(source), dtype=np.float32) / 255
    base, stars = astro_scene._star_layers(rgb)
    reconstructed = base.copy()
    for star in stars:
        x, y, r = star["x"], star["y"], star["radius"]
        patch = star["patch"]
        alpha = patch[:, :, 3:]
        region = np.s_[y-r:y+r+1, x-r:x+r+1]
        reconstructed[region] = astro_scene._linear(patch[:, :, :3]) * alpha + base[region] * (1 - alpha)
    assert len(stars) == 4
    assert np.allclose(reconstructed, astro_scene._linear(rgb), atol=2e-7)


def test_texture_resolution_and_geometry_are_bounded(tmp_path):
    path = tmp_path / "large.png"
    Image.new("RGB", (2400, 1200), (31, 22, 54)).save(path)
    result = astro_scene.generate_scene(path, tmp_path / "scene")
    document, binary = read_glb(tmp_path / "scene/scene.glb")
    assert result["stats"]["texture_width"] == 1024
    assert result["stats"]["texture_height"] == 512
    assert result["stats"]["vertices"] <= 129 ** 2
    assert embedded_image(document, binary, 0).size == (1024, 512)
    assert result["stats"]["star_layers"] == 0
    assert np.all(accessor(document, binary, 0)[:, 2] == 0)


def test_exif_orientation_and_transparency(tmp_path):
    jpeg = tmp_path / "rotated.jpg"
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (80, 40), "red").save(jpeg, exif=exif)
    result = astro_scene.generate_scene(jpeg, tmp_path / "jpeg")
    assert result["stats"]["source_width"] == 40 and result["stats"]["source_height"] == 80
    png = tmp_path / "transparent.png"
    Image.new("RGBA", (2, 2), (255, 0, 0, 128)).save(png)
    astro_scene.generate_scene(png, tmp_path / "png")
    doc, binary = read_glb(tmp_path / "png/scene.glb")
    assert embedded_image(doc, binary, 0).getpixel((0, 0)) == (128, 0, 0)


@pytest.mark.parametrize("setting", [float("nan"), float("inf"), -0.01, 1.1, True, "0.5", None])
def test_invalid_depth_rejected_before_writing(source, tmp_path, setting):
    with pytest.raises(ValueError, match="Depth"):
        astro_scene.generate_scene(source, tmp_path / "invalid", depth=setting)
    assert not (tmp_path / "invalid").exists()


@pytest.mark.parametrize("setting", [-1, 2**32, 0.5, True, None])
def test_invalid_seed_rejected(source, tmp_path, setting):
    with pytest.raises(ValueError, match="Seed"):
        astro_scene.generate_scene(source, tmp_path / "invalid", seed=setting)


def test_bad_input_format_dimensions_and_source_overwrite_are_rejected(tmp_path, monkeypatch):
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not an image")
    with pytest.raises(ValueError, match="readable"):
        astro_scene.generate_scene(bad, tmp_path / "out")
    Image.new("RGB", (1, 10)).save(bad)
    with pytest.raises(ValueError, match="two pixels"):
        astro_scene.generate_scene(bad, tmp_path / "out")
    Image.new("RGB", (10, 10)).save(bad)
    monkeypatch.setattr(astro_scene, "MAX_PIXELS", 50)
    with pytest.raises(ValueError, match="25 million"):
        astro_scene.generate_scene(bad, tmp_path / "out")
    monkeypatch.setattr(astro_scene, "MAX_PIXELS", 25_000_000)
    gif = tmp_path / "wrong.gif"
    Image.new("RGB", (10, 10)).save(gif)
    with pytest.raises(ValueError, match="PNG or JPEG"):
        astro_scene.generate_scene(gif, tmp_path / "out")
    original = tmp_path / "preview.png"
    Image.new("RGB", (10, 10)).save(original)
    saved = original.read_bytes()
    with pytest.raises(ValueError, match="overwrite"):
        astro_scene.generate_scene(original, tmp_path)
    assert original.read_bytes() == saved
    assert not (tmp_path / "out").exists()
