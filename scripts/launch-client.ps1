$ErrorActionPreference = 'Stop'
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 20 or later is required.'
    exit 1
}
& node.exe (Join-Path $PSScriptRoot '../dist/scripts/launch-client.js') @args
exit $LASTEXITCODE
