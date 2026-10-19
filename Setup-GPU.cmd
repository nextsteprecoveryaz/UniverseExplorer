@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-GPU.ps1"
if errorlevel 1 (echo GPU setup failed. Read the error above. & pause & exit /b 1)
echo GPU enhancement is ready. Refresh Universe Explorer.
pause
