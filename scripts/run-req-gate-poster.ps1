<#
  cc req-gate status poster - watchdog (REQ-G003.AC9). Run as a persistent Scheduled Task (scripts\install-req-gate-poster.ps1).
  Loops forever: runs `node scripts\status-poster.mjs --home <home>` from the pinned copy of main, restarts it 10 s after it exits,
  and logs each child PID with its start time.
#>
param([string]$Home_ = "C:\ProgramData\HELM\cc-req-gate")
$ErrorActionPreference = "Continue"
$pinned = Join-Path $Home_ "pinned"
$logDir = Join-Path $Home_ "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "watchdog.log"
function Write-Log($m) { for ($i = 0; $i -lt 5; $i++) { try { Add-Content -Path $logPath -Value "$(Get-Date -Format o) $m" -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 500 } } }
$poster = Join-Path $pinned "scripts\status-poster.mjs"
if (-not (Test-Path $poster)) { Write-Log "not installed: $poster missing (run scripts\install-req-gate-poster.ps1)"; throw "not installed: $poster" }
Write-Log "watchdog started pid $PID"
while ($true) {
    $proc = Start-Process -FilePath "node" -ArgumentList "`"$poster`"", "--home", "`"$Home_`"" -WorkingDirectory $pinned -RedirectStandardOutput (Join-Path $logDir "poster-stdout.log") -RedirectStandardError (Join-Path $logDir "poster-stderr.log") -PassThru -WindowStyle Hidden
    Write-Log "poster started pid $($proc.Id) at $($proc.StartTime.ToString('o'))"
    Wait-Process -Id $proc.Id -ErrorAction SilentlyContinue
    Write-Log "poster exited (pid $($proc.Id)) - restarting in 10s"
    Start-Sleep -Seconds 10
}
