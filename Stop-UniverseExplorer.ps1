$ErrorActionPreference = 'Stop'
$appPidFile = Join-Path $PSScriptRoot 'logs\server.pid'
if (-not (Test-Path -LiteralPath $appPidFile)) { Write-Output 'No app process was recorded.'; return }
$appPid = [int](Get-Content -LiteralPath $appPidFile)
$appProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$appPid" -ErrorAction SilentlyContinue
if (-not $appProcess) { Write-Output 'Universe Explorer is already stopped.'; return }
$expectedPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if ($appProcess.ExecutablePath -ne $expectedPython -or $appProcess.CommandLine -notlike '*uvicorn app:app*--port 8765*') {
    throw 'The recorded PID belongs to a different process. No process was stopped.'
}
Stop-Process -Id $appPid
Write-Output 'Universe Explorer stopped.'
