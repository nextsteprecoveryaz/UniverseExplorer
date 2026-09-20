param(
    [string]$Python,
    [switch]$SkipDesktop,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$appPython = Join-Path $appRoot '.venv\Scripts\python.exe'

function Test-AppPython([string]$Executable, [string[]]$Prefix = @()) {
    try {
        $probe = & $Executable @Prefix -c "import struct,sys; print(sys.executable); sys.exit(0 if sys.version_info[:2] == (3,11) and struct.calcsize('P') == 8 else 1)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $probe) { return [string]($probe | Select-Object -Last 1) }
    } catch { }
    return $null
}

function Invoke-SetupStep([string]$Description, [string[]]$Arguments) {
    Write-Host "`n$Description"
    & $appPython @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit $LASTEXITCODE). Setup is incomplete; retry after resolving the error." }
}

Push-Location $appRoot
try {
    if (Test-Path -LiteralPath $appPython) {
        $detectedPython = Test-AppPython $appPython
        if (-not $detectedPython) { throw 'The existing .venv must use 64-bit Python 3.11. Move it aside before setting up a different interpreter.' }
    } else {
        $detectedPython = $null
        if ($Python) {
            $detectedPython = Test-AppPython $Python
            if (-not $detectedPython) { throw 'The -Python argument must identify a working 64-bit Python 3.11 executable.' }
        } else {
            if (Get-Command py.exe -ErrorAction SilentlyContinue) { $detectedPython = Test-AppPython 'py.exe' @('-3.11') }
            if (-not $detectedPython -and (Get-Command python.exe -ErrorAction SilentlyContinue)) { $detectedPython = Test-AppPython 'python.exe' }
        }
        if (-not $detectedPython) { throw 'Install 64-bit Python 3.11 from python.org with its Python launcher, then rerun Setup.cmd. For a custom installation, use Setup.cmd -Python "C:\path\to\python.exe".' }
    }
    Write-Host "Using 64-bit Python 3.11: $detectedPython"
    if ($CheckOnly) { Write-Host 'Interpreter check passed. No packages or application files were installed.'; return }
    if (-not (Test-Path -LiteralPath $appPython)) {
        & $detectedPython -m venv (Join-Path $appRoot '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
    }
    Invoke-SetupStep 'Installing pinned Python dependencies' @('-m','pip','install','-r','requirements-lock.txt')
    Invoke-SetupStep 'Installing the verified local enhancement model' @('setup_model.py')
    Invoke-SetupStep 'Installing the Aladin Lite sky viewer' @('setup_atlas.py')
    Invoke-SetupStep 'Installing the local 3D viewer' @('setup_three.py')
    if (-not $SkipDesktop) { Invoke-SetupStep 'Installing Aladin Desktop and its portable Java runtime' @('setup_aladin.py') }
    Invoke-SetupStep 'Checking application imports and health endpoint' @('-c',"from fastapi.testclient import TestClient; from app import app; response=TestClient(app).get('/api/health'); assert response.status_code == 200, response.text; print('Application health check passed.')")
    Write-Host "`nSetup complete. Open Launch.cmd to start Universe Explorer."
    if ($SkipDesktop) { Write-Host 'Desktop Aladin was skipped. Run Setup.cmd again without -SkipDesktop to add it.' }
} finally { Pop-Location }
