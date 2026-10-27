[CmdletBinding()]
param([string]$OutputPath = (Join-Path $PSScriptRoot '../artifacts/cli-proxy-api.exe'), [string]$Go = 'go', [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ($Go -eq 'go' -and -not (Get-Command go -ErrorAction SilentlyContinue)) {
    $localGo = Join-Path $root '.codex/toolchain/go/bin/go.exe'
    if (Test-Path -LiteralPath $localGo) { $Go = $localGo } else { throw 'Install Go 1.26.10+ or supply -Go with its executable path.' }
}
Push-Location $root
$temporaryOutput = $OutputPath + '.build-' + [Guid]::NewGuid().ToString('N') + '.exe'
$oldOS = $env:GOOS; $oldArch = $env:GOARCH; $oldCGO = $env:CGO_ENABLED
try {
    if (-not $SkipTests) {
        & node --test internal/quotaoutlook/math.test.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Quota forecast tests failed.' }
        & $Go test ./...
        if ($LASTEXITCODE -ne 0) { throw 'Tests failed; no release built.' }
    }
    $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
    New-Item -ItemType Directory -Force (Split-Path $OutputPath -Parent) | Out-Null
    & $Go build -trimpath -o $temporaryOutput ./cmd/server
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed.' }
    Move-Item -LiteralPath $temporaryOutput -Destination $OutputPath -Force
    Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256
} finally {
    if (Test-Path -LiteralPath $temporaryOutput) { Remove-Item -LiteralPath $temporaryOutput -Force }
    $env:GOOS = $oldOS; $env:GOARCH = $oldArch; $env:CGO_ENABLED = $oldCGO
    Pop-Location
}
