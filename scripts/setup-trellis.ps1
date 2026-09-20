param(
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Distribution = 'Ubuntu-22.04',
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$linuxRoot = (& wsl.exe -d $Distribution -- wslpath -a -u $projectRoot).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxRoot.StartsWith('/')) {
    throw 'Could not access this project from WSL. Check that the selected distribution is installed.'
}
if ($VerifyOnly) {
    $config = Get-Content -LiteralPath (Join-Path $projectRoot 'data\trellis-runtime.json') -Raw | ConvertFrom-Json
    & wsl.exe -d $Distribution -- $config.python "$linuxRoot/scripts/setup-trellis-verify.py"
} else {
    & wsl.exe -d $Distribution -- env "WSL_DISTRO_NAME=$Distribution" bash "$linuxRoot/scripts/setup-trellis.sh"
}
if ($LASTEXITCODE -ne 0) {
    throw 'Local TRELLIS setup did not finish. Review the preceding error; rerunning this installer resumes setup.'
}
