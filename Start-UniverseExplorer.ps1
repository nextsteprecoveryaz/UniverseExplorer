param([switch]$NoBrowser, [switch]$Restart)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$appUrl = 'http://127.0.0.1:8765'
$appPython = Join-Path $appRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $appPython)) { throw 'Run Setup.cmd first.' }
if ($Restart) { & (Join-Path $appRoot 'Stop-UniverseExplorer.ps1') }
$running = $false
try {
    $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 3
    if ($health.app -eq 'Universe Explorer') { $running = $true }
    else { throw 'Port 8765 is occupied by another app.' }
} catch [System.Net.WebException] { }
if (-not $running) {
    $logs = Join-Path $appRoot 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $proc = Start-Process -FilePath $appPython -ArgumentList '-m uvicorn app:app --host 127.0.0.1 --port 8765' -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server-error.log')
    $proc.Id | Set-Content (Join-Path $logs 'server.pid')
    for ($attempt=0; $attempt -lt 45; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2
            if ($health.app -eq 'Universe Explorer') { $running=$true; break }
        } catch { }
        if ($proc.HasExited) { throw 'The app could not start. See logs\server-error.log.' }
    }
    if (-not $running) { throw 'The app did not become ready. See logs\server-error.log.' }
}
Write-Output "Universe Explorer is ready at $appUrl"
if (-not $NoBrowser) { Start-Process $appUrl }
