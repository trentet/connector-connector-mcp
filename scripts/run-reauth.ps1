<#
  Scheduled Google OAuth renewal: `cc reauth` for every connector whose registry entry has a googleOAuth block, run from the
  DEPLOYED cc copy so a redeploy takes effect on the next run.

    .\scripts\run-reauth.ps1 [-Environment production] [-IncludeTest] [-DryRun]

  Google expires such a token after 7 days while the OAuth app stays in Testing status, so this is scheduled more often than that
  (scripts\install-reauth-task.ps1: every 5 days). Safe by construction - cc never overwrites a token or restarts a server unless the
  new token was granted every declared scope, and it restores the previous token if the restarted server's health check fails.
  Logs: %LOCALAPPDATA%\HELM\connector-connector-mcp\logs\scheduled-reauth.log (this runner: start, finish, exit code, cc's redacted
  output) and ...\logs\reauth.log (cc's own step log). Never a token, authorization code or password.
  Exit code: 0 all renewed (or nothing due), 1 any connector failed (see the log), 2 not deployed.
#>
param([ValidateSet("production", "test")][string]$Environment = "production", [switch]$IncludeTest, [switch]$DryRun)
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
$cli = Join-Path $deploy "bin\cc.mjs"
if (-not (Test-Path $cli)) { Write-Log "not deployed: $cli missing (run node scripts\deploy.mjs $Environment)"; exit 2 }

$ccArgs = @("bin\cc.mjs", "reauth", "--all")
if ($IncludeTest) { $ccArgs += "--include-test" }
if ($DryRun) { $ccArgs += "--dry-run" }
Write-Log "=== scheduled cc reauth starting ($Environment$(if ($IncludeTest) { ', incl. test' })$(if ($DryRun) { ', dry-run' })) ==="
Push-Location $deploy
try {
    $out = & node @ccArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
} finally { Pop-Location }
foreach ($l in $out) { if ($l.Trim()) { Write-Log "  | $l" } }
Write-Log "=== scheduled cc reauth finished (exit $code) ==="
exit $code
