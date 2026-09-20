#!/usr/bin/env bash
# This installer only changes Universe Explorer's dedicated WSL runtime.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="${TRELLIS_RUNTIME_ROOT:-$HOME/UniverseExplorer-runtime}"
conda_executable="${TRELLIS_CONDA:-$HOME/miniconda/bin/conda}"
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda-12.8}"
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-12.0}"
export MAX_JOBS="${MAX_JOBS:-4}"
export PATH="$CUDA_HOME/bin:$PATH"
if [[ ! -x "$conda_executable" || ! -x "$CUDA_HOME/bin/nvcc" ]]; then
  echo 'TRELLIS needs Conda and CUDA Toolkit 12.8 inside WSL. Set TRELLIS_CONDA / CUDA_HOME to their paths.' >&2
  exit 1
fi
mkdir -p "$runtime_root/extensions"
clone_source() {
  local url="$1" directory="$2" revision="$3"
  if [[ ! -d "$directory/.git" ]]; then
    git clone "$url" "$directory"
    git -C "$directory" checkout --detach "$revision"
  elif [[ "$(git -C "$directory" rev-parse HEAD)" != "$revision" ]]; then
    echo "Unexpected revision in $directory; leaving the existing checkout untouched." >&2
    exit 1
  fi
  git -C "$directory" submodule update --init --recursive
}
clone_source https://github.com/microsoft/TRELLIS.2.git "$runtime_root/TRELLIS.2" 75fbf0183001ed9876c8dbb35de6b68552ee08bd
clone_source https://github.com/JeffreyXiang/CuMesh.git "$runtime_root/extensions/CuMesh" 12289e1062f0603f2f0d0771b02e1395d247f26f
clone_source https://github.com/JeffreyXiang/FlexGEMM.git "$runtime_root/extensions/FlexGEMM" 6dd94a859c26ee8246888502eada3dd8ad85532e
clone_source https://github.com/NVlabs/nvdiffrast.git "$runtime_root/extensions/nvdiffrast" 253ac4fcea7de5f396371124af597e6cc957bfae
clone_source https://github.com/JeffreyXiang/nvdiffrec.git "$runtime_root/extensions/nvdiffrec" b296927cc7fd01c2ac1087c8065c4d7248f72da4
if [[ ! -x "$runtime_root/env/bin/python" ]]; then
  "$conda_executable" create -y -p "$runtime_root/env" python=3.11 pip
fi
runtime_python="$runtime_root/env/bin/python"
"$runtime_python" "$project_root/scripts/setup-trellis-verify.py" --configure "$runtime_root"
"$runtime_python" -m pip install --progress-bar off torch==2.7.1 torchvision==0.22.1 xformers==0.0.31.post1 --index-url https://download.pytorch.org/whl/cu128
"$runtime_python" -m pip install --progress-bar off imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja trimesh transformers==4.57.3 tensorboard pandas lpips zstandard kornia timm 'numpy<2' 'git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8'
# Dependencies are installed above. --no-deps avoids pip treating the same
# CuMesh/FlexGEMM local checkout and upstream git URL as conflicting packages.
"$runtime_python" -m pip install --no-build-isolation --no-deps "$runtime_root/extensions/nvdiffrast" "$runtime_root/extensions/nvdiffrec" "$runtime_root/extensions/CuMesh" "$runtime_root/extensions/FlexGEMM" "$runtime_root/TRELLIS.2/o-voxel"
"$runtime_python" "$project_root/scripts/setup-trellis-smoke.py"
"$runtime_python" "$project_root/scripts/setup-trellis-download.py"
"$runtime_python" "$project_root/scripts/setup-trellis-verify.py"
