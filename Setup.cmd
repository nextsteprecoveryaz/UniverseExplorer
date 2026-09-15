@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-UniverseExplorer.ps1" %*
set "setupExit=%ERRORLEVEL%"
if not "%setupExit%"=="0" echo Setup failed. Read the error above before trying again.
pause
exit /b %setupExit%
