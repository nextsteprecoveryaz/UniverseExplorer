$ErrorActionPreference='Stop'
$gpuPython=Join-Path $PSScriptRoot '.venv-gpu\Scripts\python.exe'
$appPython=Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
Push-Location $PSScriptRoot
try {
    if (!(Test-Path -LiteralPath $appPython)) { throw 'Run Setup.cmd first to install the main application.' }
    if (!(Test-Path -LiteralPath $gpuPython)) {
        & $appPython -m venv (Join-Path $PSScriptRoot '.venv-gpu')
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated GPU environment.' }
    }
    Write-Host 'Installing local NVIDIA CUDA inference (about 3 GB download on first setup)...'
    & $gpuPython -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128
    if ($LASTEXITCODE -ne 0) { throw 'CUDA PyTorch installation failed.' }
    & $gpuPython -m pip install numpy==2.4.6 pillow==12.3.0
    if ($LASTEXITCODE -ne 0) { throw 'Image dependencies failed to install.' }
    & $appPython setup_gpu.py
    if ($LASTEXITCODE -ne 0) { throw 'Model download or actual CUDA execution check failed.' }
    Write-Host 'Local GPU models verified and CUDA kernel tested. Refresh the Image Lab.'
} finally { Pop-Location }
