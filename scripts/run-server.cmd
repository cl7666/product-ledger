@echo off
rem Start the API server in a separate cmd window and redirect its logs.
rem
rem Why this wrapper exists:
rem   PowerShell's "Start-Process -RedirectStandardOutput" passes the caller's
rem   stdout handle down to the long-running node process. When start-app.ps1 is
rem   invoked from a pipe or a scheduled task (e.g. ... | Select-Object -Last 5),
rem   the caller waits for EOF while node keeps the write end open, so it looks
rem   like "server started but the script never returns".
rem   Launching cmd through ShellExecute (no -Redirect*) does not inherit handles,
rem   and the redirection below keeps the logs.
rem
rem Keep this file ASCII-only: cmd.exe decodes batch files with the OEM code page
rem (GBK on zh-CN Windows), so UTF-8 comments would be garbled.
setlocal
cd /d "%~dp0..\server"
node src\index.js 1>>"..\logs\server.log" 2>>"..\logs\server.err.log"
