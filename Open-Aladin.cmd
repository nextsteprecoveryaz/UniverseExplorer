@echo off
cd /d "%~dp0"
.venv\Scripts\python.exe -c "import aladin_desktop; print(aladin_desktop.launch())"
if errorlevel 1 pause
