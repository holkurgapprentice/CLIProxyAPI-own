[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$ProductionPath,
    [string]$HealthUri = 'http://127.0.0.1:8317/healthz',
    [string]$Go = 'go',
    [switch]$RunTests,
    [switch]$SkipTests,
    [int]$StartupSeconds = 60
)
$ErrorActionPreference = 'Stop'
if ($RunTests -and $SkipTests) { throw 'Use either -RunTests or -SkipTests, not both.' }
# Machine-specific settings live in the git-ignored .env.promotion; parameters take precedence.
$settingsFile = Join-Path $PSScriptRoot '../.env.promotion'
$settings = @{}
if (Test-Path -LiteralPath $settingsFile -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $settingsFile) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $settings[$Matches[1]] = $Matches[2].Trim('"', "'") }
    }
}
if (-not $ProductionPath) { $ProductionPath = $settings['CLIPROXY_PRODUCTION_PATH'] }
if (-not $ProductionPath) { throw 'Production path not set. Copy .env.promotion.example to .env.promotion and set CLIPROXY_PRODUCTION_PATH, or pass -ProductionPath.' }
if (-not $PSBoundParameters.ContainsKey('HealthUri') -and $settings['CLIPROXY_HEALTH_URI']) { $HealthUri = $settings['CLIPROXY_HEALTH_URI'] }
$production = (Resolve-Path -LiteralPath $ProductionPath).Path
$exe = Join-Path $production 'cli-proxy-api.exe'
$config = Join-Path $production 'config.yaml'
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Production config.yaml must already exist. No configuration is copied or created.' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Existing production executable required for rollback.' }
$uri = [Uri]$HealthUri
if (-not $uri.IsLoopback -or $uri.Scheme -notin @('http','https')) { throw 'HealthUri must be a loopback HTTP endpoint.' }
if ($StartupSeconds -lt 1) { throw 'StartupSeconds must be positive.' }
if (-not $PSCmdlet.ShouldProcess($exe, 'Build, stop only this installation, replace binary, restart and verify; roll back on failure')) { return }
$lock = $null
$stage = "$exe.new"
function Get-InstallationProcess {
    Get-Process -Name 'cli-proxy-api' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals($_.Path, $exe, [StringComparison]::OrdinalIgnoreCase) }
}
function Stop-Installation {
    foreach ($process in @(Get-InstallationProcess)) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        if (-not $process.WaitForExit(15000)) { throw 'Production process did not exit.' }
    }
}
function Start-Installation {
    $logs = Join-Path $production 'logs'
    New-Item -ItemType Directory -Force $logs | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    Start-Process -FilePath $exe -ArgumentList @('--config', ('"' + $config + '"')) -WorkingDirectory $production -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "promotion-$stamp.out.log") -RedirectStandardError (Join-Path $logs "promotion-$stamp.err.log") | Out-Null
}
function Wait-Installation {
    param([Uri]$ProbeUri = $uri)
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupSeconds)
    do {
        $processes = @(Get-InstallationProcess)
        $listeners = @(Get-NetTCPConnection -LocalPort $ProbeUri.Port -State Listen -ErrorAction SilentlyContinue)
        if ($processes.Count -gt 0 -and @($listeners | Where-Object { $_.OwningProcess -in $processes.Id }).Count -gt 0) {
            try {
                $response = Invoke-WebRequest -Uri $ProbeUri -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -eq 200) { return }
            } catch { }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Production did not become healthy. Inspect local logs; credentials are not printed.'
}
try {
    $lock = [IO.File]::Open((Join-Path $production '.promotion.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $artifact = Join-Path $PSScriptRoot '../artifacts/cli-proxy-api.exe'
    if ($RunTests) { Write-Host 'Running the full test suite before building.' }
    else { Write-Host 'Building for Windows. Full test suite not requested; use -RunTests to include it.' }
    & (Join-Path $PSScriptRoot 'Build-Windows.ps1') -OutputPath $artifact -Go $Go -SkipTests:(-not $RunTests)
    Write-Host 'Build complete. Backing up the installed executable; existing configuration and credentials stay in place.'
    $configHash = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
    $backupDir = Join-Path $production ('backups/promotion-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    $backup = Join-Path $backupDir 'cli-proxy-api.exe'
    Copy-Item -LiteralPath $exe -Destination $backup
    Copy-Item -LiteralPath $artifact -Destination $stage
    if ((Get-FileHash -LiteralPath $stage).Hash -ne (Get-FileHash -LiteralPath $artifact).Hash) { throw 'Staged executable hash mismatch.' }
    $wasRunning = @(Get-InstallationProcess).Count -gt 0
    try {
        Write-Host 'Stopping this installation and replacing its executable.'
        Stop-Installation
        Move-Item -LiteralPath $stage -Destination $exe -Force
        Start-Installation
        Write-Host 'Waiting for the new process to become healthy.'
        Wait-Installation
        if ((Get-FileHash -LiteralPath $config).Hash -ne $configHash) { throw 'Production configuration changed during promotion.' }
        Write-Output "Promotion healthy. Previous binary: $backup"
    } catch {
        $failure = $_
        Stop-Installation
        Copy-Item -LiteralPath $backup -Destination $exe -Force
        if ($wasRunning) { Start-Installation; Wait-Installation -ProbeUri ([Uri]($uri.GetLeftPart([UriPartial]::Authority) + '/')) }
        throw "Promotion failed; previous binary restored. $($failure.Exception.Message)"
    }
} finally {
    if ($lock) {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
        $lock.Dispose()
    }
}
