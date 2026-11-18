<#
  Scheduled Google OAuth renewal: `cc reauth` for every connector whose registry entry has a googleOAuth block, run from the
  DEPLOYED cc copy so a redeploy takes effect on the next run.

    .\scripts\run-reauth.ps1 [-Environment production] [-IncludeTest] [-DryRun] [-Connectors id1,id2] [-OnlyIfOlderThanDays 4.75] [-SkipCoverage]

  Defaults renew every connector with a googleOAuth block (`reauth --all`) and run the coverage guard afterwards. A SECOND renewer on another host
  passes -Connectors <ids> (never --all), -OnlyIfOlderThanDays (it renews only when the first job has not: see docs/SPEC.md section 10) and -SkipCoverage
  (the coverage guard needs gh and belongs to the primary).

  Google expires such a token after 7 days while the OAuth app stays in Testing status, so this is scheduled more often than that
  (scripts\install-reauth-task.ps1: every 5 days). Safe by construction - cc never overwrites a token or restarts a server unless the
  new token was granted every declared scope, and it restores the previous token if the restarted server's health check fails.
  Logs: %LOCALAPPDATA%\HELM\connector-connector-mcp\logs\scheduled-reauth.log (this runner: start, finish, exit code, cc's redacted
  output) and ...\logs\reauth.log (cc's own step log). Never a token, authorization code or password.
  After the renewal it also runs the coverage guard (`cc audit --google --github <owner>`): a repo that uses Google OAuth but has no registry
  googleOAuth block is logged as "GOOGLE COVERAGE GAP" so a new Google connector can never be silently left out of the weekly renewal.
  Exit code: 0 all renewed (or nothing due) and no coverage gap, 1 any connector failed (see the log), 2 not deployed, 3 renewals fine but a coverage gap exists, 4 renewals reported fine but a sign-in is low, expired or unreadable (alert raised).
#>
param([ValidateSet("production", "test")][string]$Environment = "production", [switch]$IncludeTest, [switch]$DryRun, [string]$GithubOwner = "trentet",
    [ValidatePattern('^$|^[a-z0-9][a-z0-9-]*([, ]+[a-z0-9][a-z0-9-]*)*$')][string]$Connectors = "",
    [ValidateRange(0, 6)][double]$OnlyIfOlderThanDays = 0, [switch]$SkipCoverage)
$ErrorActionPreference = "Continue"
$base = Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp"
$deploy = Join-Path $base "deploy\$Environment"
$logDir = Join-Path $base "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "scheduled-reauth.log"
function Write-Log($m) {
    $line = "$(Get-Date -Format o) $m"
    for ($i = 0; $i -lt 5; $i++) { try { Add-Content -Path $logPath -Value $line -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 500 } }
    try { Add-Content -Path (Join-Path $env:TEMP "cc-scheduled-reauth-fallback.log") -Value $line -ErrorAction Stop } catch { }
}
# REQ-D013: a scheduled (daily) run shows no window and takes no focus: its Chrome starts on its own Windows desktop (REQ-D006).
if (-not $env:CC_CHROME_DESKTOP) { $env:CC_CHROME_DESKTOP = "own" }
$cli = Join-Path $deploy "bin\cc.mjs"
if (-not (Test-Path $cli)) { Write-Log "not deployed: $cli missing (run node scripts\deploy.mjs $Environment)"; exit 2 }

$ids = @($Connectors -split "[,\s]+" | Where-Object { $_ })
$ccArgs = @("bin\cc.mjs", "reauth")
if ($ids.Count -gt 0) { $ccArgs += $ids } else { $ccArgs += "--all" }
if ($OnlyIfOlderThanDays -gt 0) { $ccArgs += "--only-if-older-than"; $ccArgs += $OnlyIfOlderThanDays.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
if ($IncludeTest) { $ccArgs += "--include-test" }
if ($DryRun) { $ccArgs += "--dry-run" }
Write-Log "=== scheduled cc reauth starting ($Environment$(if ($IncludeTest) { ', incl. test' })$(if ($DryRun) { ', dry-run' })$(if ($ids.Count -gt 0) { ', ' + ($ids -join '+') })$(if ($OnlyIfOlderThanDays -gt 0) { ", only if older than $OnlyIfOlderThanDays days" })) ==="
Push-Location $deploy
try {
    $out = & node @ccArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
} finally { Pop-Location }
foreach ($l in $out) { if ($l.Trim()) { Write-Log "  | $l" } }
Write-Log "=== scheduled cc reauth finished (# REQ-D013 REQ-D014: after EVERY run, report the hours left on every sign-in and raise the alert (alert file, ALERT lines, CC_ALERT_COMMAND hook)
# when the run failed or a sign-in is low, expired or unreadable. A failed run is therefore never silent, and the daily schedule retries it.
$statusArgs = @(); if ($code -ne 0) { $statusArgs += "--run-failed" }
Push-Location $deploy
try {
    $status = & node bin\cc.mjs reauth --all --status @statusArgs 2>&1 | ForEach-Object { "$_" }
    $statusCode = $LASTEXITCODE
} finally { Pop-Location }
foreach ($l in $status) { if ($l.Trim()) { Write-Log "  | status: $l" } }
if ($statusCode -ne 0 -and $code -eq 0) { $code = 4 }
Write-Log "=== sign-in status check finished (exit $statusCode); scheduled run exit $code ==="
exit $code) ==="

# Coverage guard: reads repos through the host's gh (no clones, no secrets); a gh problem is only a note, never a failure of the renewal itself.
# A second renewer skips it (-SkipCoverage): the guard belongs to the primary and needs gh.
if (-not $SkipCoverage) {
    Push-Location $deploy
    try {
        $gap = & node bin\cc.mjs audit --google --github $GithubOwner 2>&1 | ForEach-Object { "$_" }
        $gapCode = $LASTEXITCODE
    } finally { Pop-Location }
    foreach ($l in $gap) { if ($l.Trim()) { Write-Log "  | coverage: $l" } }
    if ($gapCode -eq 1) {
        Write-Log "GOOGLE COVERAGE GAP: a repo uses Google OAuth but no registry entry has a googleOAuth block for it (see the UNCOVERED lines above). Its token will expire in 7 days unless it is added."
        if ($code -eq 0) { $code = 3 }
    }
}
# REQ-D013 REQ-D014: after EVERY run, report the hours left on every sign-in and raise the alert (alert file, ALERT lines, CC_ALERT_COMMAND hook)
# when the run failed or a sign-in is low, expired or unreadable. A failed run is therefore never silent, and the daily schedule retries it.
$statusArgs = @(); if ($code -ne 0) { $statusArgs += "--run-failed" }
Push-Location $deploy
try {
    $status = & node bin\cc.mjs reauth --all --status @statusArgs 2>&1 | ForEach-Object { "$_" }
    $statusCode = $LASTEXITCODE
} finally { Pop-Location }
foreach ($l in $status) { if ($l.Trim()) { Write-Log "  | status: $l" } }
if ($statusCode -ne 0 -and $code -eq 0) { $code = 4 }
Write-Log "=== sign-in status check finished (exit $statusCode); scheduled run exit $code ==="
exit $code
