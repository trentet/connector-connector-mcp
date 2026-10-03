<#
  Registers the scheduled Google OAuth renewal (idempotent; replaces the same-named task): runs scripts\run-reauth.ps1 from the DEPLOYED
  cc copy every 5 days, comfortably inside Google's 7-day refresh-token expiry.

    .\scripts\install-reauth-task.ps1 [-Environment production] [-At 03:30] [-Start]

  Retires the legacy 'HELM TT-MCP Google Reauth' task if present: it ran a script that lived in patchright-mcp, which cc reauth replaced
  (docs/SPEC.md section 10); that script no longer exists, so the task would only fail.
  Also switches on Task Scheduler history (Microsoft-Windows-TaskScheduler/Operational) - the setup standard for any host that runs
  Scheduled Tasks; needs an elevated shell once, otherwise it warns with the exact command and carries on.
#>
param([ValidateSet("production", "test")][string]$Environment = "production", [string]$At = "03:30", [switch]$Start)
$ErrorActionPreference = "Stop"
$base = Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp"
$runner = Join-Path $base "deploy\$Environment\scripts\run-reauth.ps1"
if (-not (Test-Path $runner)) { throw "$runner not found: deploy first (node scripts\deploy.mjs $Environment)" }

try {
    $log = Get-WinEvent -ListLog "Microsoft-Windows-TaskScheduler/Operational" -ErrorAction Stop
    if (-not $log.IsEnabled -or $log.MaximumSizeInBytes -lt 16MB) {
        & wevtutil.exe sl "Microsoft-Windows-TaskScheduler/Operational" /e:true "/ms:$([Math]::Max([int64]$log.MaximumSizeInBytes, [int64]16MB))" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "wevtutil exited $LASTEXITCODE (access denied means this shell isn't elevated)" }
        Write-Host "Task Scheduler history switched on."
    }
} catch {
    Write-Warning "Could not switch on Task Scheduler history: $($_.Exception.Message). From an elevated PowerShell run: wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true /ms:16777216"
}

$name = "cc-mcp Google Reauth"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Environment $Environment"
# StartWhenAvailable: if the PC was off or asleep at the scheduled time, run as soon as it is back.
$trigger = New-ScheduledTaskTrigger -Daily -DaysInterval 5 -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
# Interactive: cc drives a visible-profile Chrome, which needs the logged-on desktop session.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "cc reauth: renews every connector's Google OAuth token before Google's 7-day expiry. Log: %LOCALAPPDATA%\HELM\connector-connector-mcp\logs\scheduled-reauth.log" -Force | Out-Null
Write-Host "Registered '$name' (every 5 days at $At)."

$legacy = Get-ScheduledTask -TaskName "HELM TT-MCP Google Reauth" -ErrorAction SilentlyContinue
if ($legacy) { Unregister-ScheduledTask -TaskName "HELM TT-MCP Google Reauth" -Confirm:$false; Write-Host "Retired the legacy 'HELM TT-MCP Google Reauth' task (cc reauth replaces it)." }
if ($Start) { Start-ScheduledTask -TaskName $name; Write-Host "Started '$name'." }
