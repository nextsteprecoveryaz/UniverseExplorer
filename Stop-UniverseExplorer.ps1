$ErrorActionPreference = 'Stop'
$appPidFile = Join-Path $PSScriptRoot 'logs\server.pid'
if (-not (Test-Path -LiteralPath $appPidFile)) { Write-Output 'No app process was recorded.'; return }
$appPid = [int](Get-Content -LiteralPath $appPidFile)
$appProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$appPid" -ErrorAction Stop
$expectedPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$basePython = & $expectedPython -c 'import sys; print(sys._base_executable)'
if ($LASTEXITCODE -ne 0) { throw 'Could not verify the app Python runtime. No process was stopped.' }
$appChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$appPid" -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -eq $basePython -and $_.CommandLine -like '*-m uvicorn app:app --host 127.0.0.1 --port 8765*'
})
if ($appProcess -and ($appProcess.ExecutablePath -ne $expectedPython -or $appProcess.CommandLine -notlike '*uvicorn app:app*--port 8765*')) {
    throw 'The recorded PID belongs to a different process. No process was stopped.'
}
# Windows venv launchers can leave a base-interpreter child running. Stop only
# verified uvicorn children of this launcher's recorded process before the wrapper.
foreach ($appChild in $appChildren) { Stop-Process -Id $appChild.ProcessId -ErrorAction Stop }
if ($appProcess -and (Get-Process -Id $appPid -ErrorAction SilentlyContinue)) { Stop-Process -Id $appPid -ErrorAction Stop }
if (-not $appProcess -and -not $appChildren.Count) { Write-Output 'Universe Explorer is already stopped.'; return }
Write-Output 'Universe Explorer stopped.'
