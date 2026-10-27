[CmdletBinding()]
param([string]$Go = 'go')
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('cliproxy-promotion-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$processes = @()
try {
    $source = Join-Path $fixture 'fixture.go'
    @'
package main
import ("flag"; "net/http"; "os"; "strings")
func main(){p:=flag.String("config","","");flag.Parse();data,e:=os.ReadFile(*p);if e!=nil{panic(e)};port:=strings.TrimSpace(strings.Split(string(data),"\n")[0]);http.HandleFunc("/",func(w http.ResponseWriter,r *http.Request){w.Write([]byte("{\"status\":\"ok\"}"))});http.ListenAndServe("127.0.0.1:"+port,nil)}
'@ | Set-Content -LiteralPath $source
    $good = Join-Path $fixture 'good.exe'
    & $Go build -o $good $source
    if ($LASTEXITCODE -ne 0) { throw 'Fixture build failed.' }
    $bad = Join-Path $fixture 'bad.exe'
    'This is deliberately not an executable.' | Set-Content -LiteralPath $bad
    $fakeGo = Join-Path $fixture 'go.ps1'
    @'
Add-Content -LiteralPath $env:PROMOTION_TEST_CALLS -Value $args[0]
if ($args[0] -eq 'test') { exit 1 }
if ($env:PROMOTION_TEST_FAIL_BUILD -eq '1') { exit 1 }
$i = [Array]::IndexOf($args, '-o')
if ($i -lt 0) { throw 'Unexpected fixture Go invocation.' }
Copy-Item -LiteralPath $env:PROMOTION_TEST_ARTIFACT -Destination $args[$i + 1] -Force
exit 0
'@ | Set-Content -LiteralPath $fakeGo
    $production = Join-Path $fixture 'production'
    $neighbor = Join-Path $fixture 'neighbor'
    foreach ($dir in @($production,$neighbor)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
        Copy-Item -LiteralPath $good -Destination (Join-Path $dir 'cli-proxy-api.exe')
    }
    # Ask Windows for two available ephemeral ports, rather than assuming fixed test ports.
    $ports = @()
    $reservations = @()
    foreach ($i in 1..2) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start(); $reservations += $listener; $ports += $listener.LocalEndpoint.Port
    }
    $reservations | ForEach-Object { $_.Stop() }
    $config = Join-Path $production 'config.yaml'
    "$($ports[0])
sentinel-config-do-not-change" | Set-Content -LiteralPath $config
    "$($ports[1])" | Set-Content -LiteralPath (Join-Path $neighbor 'config.yaml')
    New-Item -ItemType Directory -Path (Join-Path $production 'auths'),(Join-Path $production 'static') | Out-Null
    'sentinel-auth-not-a-token' | Set-Content (Join-Path $production 'auths/sentinel.json')
    'sentinel-environment' | Set-Content (Join-Path $production '.env')
    'sentinel-ui' | Set-Content (Join-Path $production 'static/management.html')
    'sentinel-startup' | Set-Content (Join-Path $production 'Start-CLIProxyAPI.ps1')
    $protected = @('config.yaml','.env','auths/sentinel.json','static/management.html','Start-CLIProxyAPI.ps1')
    $hashes = @{}
    foreach ($file in $protected) { $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $production $file)).Hash }
    foreach ($dir in @($production,$neighbor)) {
        $processes += Start-Process -FilePath (Join-Path $dir 'cli-proxy-api.exe') -ArgumentList @('--config', ('"' + (Join-Path $dir 'config.yaml') + '"')) -WorkingDirectory $dir -WindowStyle Hidden -PassThru
    }
    $env:PROMOTION_TEST_CALLS = Join-Path $fixture 'go-calls.txt'
    $env:PROMOTION_TEST_ARTIFACT = $good
    $fixtureScripts = Join-Path $fixture 'scripts'
    New-Item -ItemType Directory -Path $fixtureScripts | Out-Null
    foreach ($script in @('Promote-Production.ps1','Build-Windows.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $fixtureScripts $script) }
    $mathDir = Join-Path $fixture 'internal/quotaoutlook'
    New-Item -ItemType Directory -Path $mathDir -Force | Out-Null
    foreach ($file in @('math.js','math.test.cjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../internal/quotaoutlook/$file") -Destination (Join-Path $mathDir $file) }
    $promote = Join-Path $fixtureScripts 'Promote-Production.ps1'
    & $promote -ProductionPath $production -HealthUri "http://127.0.0.1:$($ports[0])/healthz" -Go $fakeGo -WhatIf
    if (Test-Path -LiteralPath $env:PROMOTION_TEST_CALLS) { throw 'WhatIf invoked the build.' }
    if (Test-Path -LiteralPath (Join-Path $production '.promotion.lock')) { throw 'WhatIf created a lock.' }
    foreach ($mode in @('tests','build')) {
        $env:PROMOTION_TEST_FAIL_BUILD = if ($mode -eq 'build') { '1' } else { '0' }
        $failed = $false
        try { & $promote -ProductionPath $production -HealthUri "http://127.0.0.1:$($ports[0])/healthz" -Go $fakeGo -RunTests:($mode -eq 'tests') -StartupSeconds 10 -Confirm:$false } catch { $failed = $true }
        if (-not $failed) { throw "Expected $mode failure did not stop promotion." }
        $expectedCalls = if ($mode -eq 'tests') { 'test' } else { 'test,build' }
        if ((@(Get-Content -LiteralPath $env:PROMOTION_TEST_CALLS) -join ',') -ne $expectedCalls) { throw "Did not reach the expected $mode failure." }
        $processes[0].Refresh()
        if ($processes[0].HasExited) { throw "$mode failure stopped production." }
        if ((Get-FileHash -LiteralPath (Join-Path $production 'cli-proxy-api.exe')).Hash -ne (Get-FileHash -LiteralPath $good).Hash) { throw "$mode failure replaced production." }
        if (Test-Path -LiteralPath (Join-Path $production 'backups')) { throw "$mode failure reached backup/deployment." }
        foreach ($file in $protected) { if ((Get-FileHash -LiteralPath (Join-Path $production $file)).Hash -ne $hashes[$file]) { throw "$mode failure modified $file" } }
    }
    $env:PROMOTION_TEST_FAIL_BUILD = '0'
    Remove-Item -LiteralPath $env:PROMOTION_TEST_CALLS

    & $promote -ProductionPath $production -HealthUri "http://127.0.0.1:$($ports[0])/healthz" -Go $fakeGo -StartupSeconds 10 -Confirm:$false
    if ((@(Get-Content -LiteralPath $env:PROMOTION_TEST_CALLS) -join ',') -ne 'build') { throw 'Default promotion did not build directly.' }
    $processes[0].Refresh()
    if (-not $processes[0].HasExited) { throw 'Default promotion did not restart the installation.' }
    foreach ($file in $protected) { if ((Get-FileHash -LiteralPath (Join-Path $production $file)).Hash -ne $hashes[$file]) { throw "Promotion modified $file" } }
    if ($processes[1].HasExited) { throw 'Promotion stopped the neighboring installation.' }
    $expectedHash = (Get-FileHash -LiteralPath (Join-Path $production 'cli-proxy-api.exe')).Hash
    $env:PROMOTION_TEST_ARTIFACT = $bad
    $failed = $false
    try { & $promote -ProductionPath $production -HealthUri "http://127.0.0.1:$($ports[0])/healthz" -Go $fakeGo -StartupSeconds 3 -Confirm:$false } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid executable did not fail promotion.' }
    if ((Get-FileHash -LiteralPath (Join-Path $production 'cli-proxy-api.exe')).Hash -ne $expectedHash) { throw 'Rollback did not restore binary.' }
    $response = Invoke-WebRequest "http://127.0.0.1:$($ports[0])/healthz" -UseBasicParsing
    if ($response.StatusCode -ne 200) { throw 'Rollback did not restart previous executable.' }
    foreach ($file in $protected) { if ((Get-FileHash -LiteralPath (Join-Path $production $file)).Hash -ne $hashes[$file]) { throw "Rollback modified $file" } }
    if ($processes[1].HasExited) { throw 'Rollback stopped the neighboring installation.' }
    Write-Output 'PASS: default build/deploy, opt-in test gate, build failure safety, WhatIf, restart, rollback, exact-path isolation, and configuration preservation.'
} finally {
    $env:PROMOTION_TEST_ARTIFACT = $null
    $env:PROMOTION_TEST_CALLS = $null
    $env:PROMOTION_TEST_FAIL_BUILD = $null
    Get-Process -Name 'cli-proxy-api' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($fixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
    Write-Output "Fixture evidence retained at $fixture"
}
