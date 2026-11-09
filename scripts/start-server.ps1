$ErrorActionPreference = 'Stop'
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 20 or later is required.'
    exit 1
}
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    & node.exe dist/src/cli.js @args
    $result = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $result
