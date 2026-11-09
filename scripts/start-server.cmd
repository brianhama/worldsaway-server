@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
    echo Node.js 20 or later is required. 1>&2
    exit /b 1
)
pushd "%~dp0.."
node.exe dist\src\cli.js %*
set "result=%errorlevel%"
popd
exit /b %result%
