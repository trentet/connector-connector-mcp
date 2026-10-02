<#
  cc - server watchdog, one environment per invocation. Run as a persistent Scheduled Task (scripts\install-tasks.ps1).
  Loops forever: runs `node scripts\start.mjs <env>` from the deployed copy, restarts with a 5s backoff if it exits.
#>
param([Parameter(Mandatory = $true)][ValidateSet("production", "test")][string]$Environment)
$ErrorActionPreference = "Continue"
$base = Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp"
$deploy = Join-Path $base "deploy\$Environment"
$logDir = Join-Path $base "$Environment\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "server.log"
function Write-Log($m) { for ($i = 0; $i -lt 5; $i++) { try { Add-Content -Path $logPath -Value "$(Get-Date -Format o) $m" -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 500 } } }
$start = Join-Path $deploy "scripts\start.mjs"
if (-not (Test-Path $start)) { Write-Log "not deployed: $start missing (run node scripts\deploy.mjs $Environment)"; throw "not deployed: $start" }
Write-Log "server watchdog started ($Environment)"
while ($true) {
    Write-Log "starting node scripts\start.mjs $Environment"
    $proc = Start-Process -FilePath "node" -ArgumentList "`"$start`"", $Environment -WorkingDirectory $deploy -RedirectStandardOutput (Join-Path $logDir "server-stdout.log") -RedirectStandardError (Join-Path $logDir "server-stderr.log") -PassThru -WindowStyle Hidden
    Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
    Write-Log "server exited (pid $($proc.Id)) - restarting in 5s"
    Start-Sleep -Seconds 5
}
