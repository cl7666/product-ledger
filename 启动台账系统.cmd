@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1" %*
if errorlevel 1 pause
endlocal
