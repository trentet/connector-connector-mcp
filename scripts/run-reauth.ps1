<#
  Scheduled Google OAuth renewal: `cc reauth` for every connector whose registry entry has a googleOAuth block, run from the
  DEPLOYED cc copy so a redeploy takes effect on the next run.

    .\scripts\run-reauth.ps1 [-Environment production] [-IncludeTest] [-DryRun]
                              [-Ids "id1,id2"] [-OnlyIfOlderThan <days>] [-SkipCoverageCheck] [-GithubOwner trentet]

  Default (no -Ids): renews every production connector that has a googleOAuth block (`cc reauth --all`) and runs the coverage guard afterwards.
  -Ids renews ONLY the named registry ids (never --all): a second host that must renew just one entry.
  -OnlyIfOlderThan <days> passes `--only-if-older-than <days>`: renew only when cc's renewal record (token.renewed.json) is older than that.
  -SkipCoverageCheck leaves out the coverage guard (it needs the gh CLI and covers the whole GitHub owner, which a single-entry host does not need).

  Google expires such a token after 7 days while the OAuth app stays in Testing status, so this is scheduled more often than that
  (scripts\install-reauth-task.ps1: every 5 days). Safe by construction - cc never overwrites a token or restarts a server unless the
  new token was granted every declared scope, and it restores the previous token if the restarted server's health check fails.
  Logs: %LOCALAPPDATA%\HELM\connector-connector-mcp\logs\scheduled-reauth.log (this runner: start, finish, exit code, cc's redacted
  output) and ...\logs\reauth.log (cc's own step log). Never a token, authorization code or password.
  After the renewal it also runs the coverage guard (`cc audit --google --github <owner>`): a repo that uses Google OAuth but has no registry
  googleOAuth block is logged as "GOOGLE COVERAGE GAP" so a new Google connector can never be silently left out of the weekly renewal.
  Exit code: 0 all renewed (or nothing due) and no coverage gap, 1 any connector failed (see the log), 2 not deployed, 3 renewals fine but a coverage gap exists, 4 an -Ids value that is not a registry id.
#>
param(
    [ValidateSet("production", "test")][string]$Environment = "production",
    [switch]$IncludeTest,
    [switch]$DryRun,
    [string]$GithubOwner = "trentet",
    # Comma- or space-separated registry ids (kebab-case only, so nothing here can reach a command line unquoted).
    [ValidatePattern('^[a-z0-9][a-z0-9, -]*$')][string]$Ids = "",
    [ValidateRange(0, 6)][double]$OnlyIfOlderThan = 0,
    [switch]$SkipCoverageCheck
)
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

$idList = @($Ids -split '[,\s]+' | Where-Object { $_ })
foreach ($id in $idList) { if ($id -notmatch '^[a-z0-9][a-z0-9-]*$') { Write-Log "refusing to run: '$id' is not a registry id"; exit 4 } }
$ccArgs = @("bin\cc.mjs", "reauth")
if ($idList.Count -gt 0) { $ccArgs += $idList } else { $ccArgs += "--all" }
if ($IncludeTest) { $ccArgs += "--include-test" }
if ($OnlyIfOlderThan -gt 0) { $ccArgs += @("--only-if-older-than", $OnlyIfOlderThan.ToString([System.Globalization.CultureInfo]::InvariantCulture)) }
if ($DryRun) { $ccArgs += "--dry-run" }
Write-Log "=== scheduled cc reauth starting ($Environment; $(if ($idList.Count -gt 0) { 'ids: ' + ($idList -join ' ') } else { 'all' })$(if ($IncludeTest) { ', incl. test' })$(if ($OnlyIfOlderThan -gt 0) { ", only if older than $OnlyIfOlderThan days" })$(if ($DryRun) { ', dry-run' })) ==="
Push-Location $deploy
try {
    $out = & node @ccArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
} finally { Pop-Location }
foreach ($l in $out) { if ($l.Trim()) { Write-Log "  | $l" } }
Write-Log "=== scheduled cc reauth finished (exit $code) ==="

if ($SkipCoverageCheck) { exit $code }

# Coverage guard: reads repos through the host's gh (no clones, no secrets); a gh problem is only a note, never a failure of the renewal itself.
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
exit $code
