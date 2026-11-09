@echo off
rem Start the API server in the background and redirect its logs.
rem
rem Why this wrapper exists:
rem   1) PowerShell's "Start-Process -RedirectStandardOutput" passes the caller's
rem      stdout handle down to the long-running node process. When start-app.ps1
rem      is invoked from a pipe or a scheduled task, the caller waits for EOF
rem      while node keeps the write end open.
rem   2) Log files are per-port, so a second instance (e.g. a test on 4409) does
rem      not collide with the running production instance on 4399.
rem   3) "start /b" returns immediately, so this cmd does not stay in the
rem      foreground waiting for node (which would also hold the caller's pipe).
rem
rem Identity: the node command line gets the absolute entry path plus the
rem "--app product-ledger" marker, so stop-app.ps1 can tell this process apart
rem from another project that also runs "node src/index.js".
rem
rem Keep this file ASCII-only: cmd.exe decodes batch files with the OEM code page
rem (GBK on zh-CN Windows), so UTF-8 comments would be garbled.
setlocal
cd /d "%~dp0..\server"
rem Port: first command-line argument wins, then PORT, then 4399.
set "PL_PORT=%~1"
if "%PL_PORT%"=="" set "PL_PORT=%PORT%"
if "%PL_PORT%"=="" set "PL_PORT=4399"
set "PORT=%PL_PORT%"
start "" /b node "%CD%\src\index.js" --app product-ledger 1>>"..\logs\server-%PL_PORT%.log" 2>>"..\logs\server-%PL_PORT%.err.log"
