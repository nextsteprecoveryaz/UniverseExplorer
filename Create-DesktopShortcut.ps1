$ErrorActionPreference='Stop'
$appDesktop=[Environment]::GetFolderPath('Desktop')
if (-not $appDesktop) { throw 'Desktop folder could not be resolved.' }
$appShortcutPath=Join-Path $appDesktop 'Universe Explorer.lnk'
if (Test-Path -LiteralPath $appShortcutPath) { Write-Output "Shortcut already exists: $appShortcutPath"; return }
$appShell=New-Object -ComObject WScript.Shell
$appShortcut=$appShell.CreateShortcut($appShortcutPath)
$appShortcut.TargetPath=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$appShortcut.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'Start-UniverseExplorer.ps1')+'"'
$appShortcut.WorkingDirectory=$PSScriptRoot
$appShortcut.Description='Explore real Webb and Hubble imagery with local AI enhancement.'
$appShortcut.IconLocation=(Join-Path $env:WINDIR 'System32\shell32.dll')+',13'
$appShortcut.Save()
Write-Output "Created $appShortcutPath"
