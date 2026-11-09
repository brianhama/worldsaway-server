@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
    echo Node.js 20 or later is required. 1>&2
    exit /b 1
)
node.exe "%~dp0..\dist\scripts\launch-client.js" %*
exit /b %errorlevel%
