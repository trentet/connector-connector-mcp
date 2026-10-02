<#
  cc - Cloudflare tunnel watchdog, one environment per invocation. Run as a persistent Scheduled Task (scripts\install-tasks.ps1).
  Loops forever: runs `cloudflared tunnel --config <env tunnel-config.yml> run <tunnel>`, restarts with a 5s backoff if it exits.
#>
param([Parameter(Mandatory = $true)][ValidateSet("production", "test")][string]$Environment)
$ErrorActionPreference = "Continue"
$tunnelName = if ($Environment -eq "production") { "cc-mcp" } else { "cc-mcp-test" }
$base = Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp"
$logDir = Join-Path $base "$Environment\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "tunnel.log"
$cf = if ($env:CLOUDFLARED_PATH) { $env:CLOUDFLARED_PATH } else { Join-Path $base "tools\cloudflared.exe" }
$cfg = Join-Path $base "$Environment\tunnel-config.yml"
function Write-Log($m) { for ($i = 0; $i -lt 5; $i++) { try { Add-Content -Path $logPath -Value "$(Get-Date -Format o) $m" -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 500 } } }
if (-not (Test-Path $cf)) { Write-Log "cloudflared not found at $cf"; throw "cloudflared not found at $cf" }
if (-not (Test-Path $cfg)) { Write-Log "tunnel config not found at $cfg (run scripts\setup-host.ps1)"; throw "tunnel config not found at $cfg" }
Write-Log "tunnel watchdog started ($Environment)"
while ($true) {
    Write-Log "starting cloudflared tunnel run $tunnelName"
    $proc = Start-Process -FilePath $cf -ArgumentList "tunnel", "--config", $cfg, "run", $tunnelName -RedirectStandardOutput (Join-Path $logDir "tunnel-stdout.log") -RedirectStandardError (Join-Path $logDir "tunnel-stderr.log") -PassThru -WindowStyle Hidden
    Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
    Write-Log "cloudflared exited (pid $($proc.Id)) - restarting in 5s"
    Start-Sleep -Seconds 5
}
