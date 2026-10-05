<#
  Registers the scheduled Google OAuth renewal (idempotent; replaces the same-named task): runs scripts\run-reauth.ps1 from the DEPLOYED
  cc copy every 5 days, comfortably inside Google's 7-day refresh-token expiry.

    .\scripts\install-reauth-task.ps1 [-Environment production] [-At 03:30] [-Start]
                                       [-TaskName "cc-mcp Google Reauth"] [-IntervalDays 5] [-Ids "id1,id2"] [-OnlyIfOlderThan <days>] [-SkipCoverageCheck]

  The defaults are the primary host's task. A second host that must renew only one entry passes -Ids (never --all), its own -TaskName, a shorter
  -IntervalDays (1 to 6; never beyond Google's 7 days), usually -OnlyIfOlderThan <days> so it renews only when the primary has not, and -SkipCoverageCheck.

  Retires the legacy 'HELM TT-MCP Google Reauth' task if present: it ran a script that lived in patchright-mcp, which cc reauth replaced
  (docs/SPEC.md section 10); that script no longer exists, so the task would only fail.
  Also switches on Task Scheduler history (Microsoft-Windows-TaskScheduler/Operational) - the setup standard for any host that runs
  Scheduled Tasks; needs an elevated shell once, otherwise it warns with the exact command and carries on.
#>
param(
    [ValidateSet("production", "test")][string]$Environment = "production",
    [string]$At = "03:30",
    [switch]$Start,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 ._-]*$')][string]$TaskName = "cc-mcp Google Reauth",
    [ValidateRange(1, 6)][int]$IntervalDays = 5,
    [ValidatePattern('^[a-z0-9][a-z0-9, -]*$')][string]$Ids = "",
    [ValidateRange(0, 6)][double]$OnlyIfOlderThan = 0,
    [switch]$SkipCoverageCheck
)
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

$name = $TaskName
$runnerArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Environment $Environment"
# The ids are validated above (kebab-case ids only), so they can go on the command line inside quotes.
if ($Ids.Trim()) { $runnerArgs += " -Ids `"$($Ids.Trim())`"" }
if ($OnlyIfOlderThan -gt 0) { $runnerArgs += " -OnlyIfOlderThan $($OnlyIfOlderThan.ToString([System.Globalization.CultureInfo]::InvariantCulture))" }
if ($SkipCoverageCheck) { $runnerArgs += " -SkipCoverageCheck" }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $runnerArgs
# StartWhenAvailable: if the PC was off or asleep at the scheduled time, run as soon as it is back.
$trigger = New-ScheduledTaskTrigger -Daily -DaysInterval $IntervalDays -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
# Interactive: cc drives a visible-profile Chrome, which needs the logged-on desktop session.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "cc reauth: renews every connector's Google OAuth token before Google's 7-day expiry. Log: %LOCALAPPDATA%\HELM\connector-connector-mcp\logs\scheduled-reauth.log" -Force | Out-Null
Write-Host "Registered '$name' (every $IntervalDays day(s) at $At$(if ($Ids.Trim()) { "; ids: $($Ids.Trim())" } else { '; all connectors with a googleOAuth block' }))."

$legacy = if ($name -eq "cc-mcp Google Reauth") { Get-ScheduledTask -TaskName "HELM TT-MCP Google Reauth" -ErrorAction SilentlyContinue }
if ($legacy) { Unregister-ScheduledTask -TaskName "HELM TT-MCP Google Reauth" -Confirm:$false; Write-Host "Retired the legacy 'HELM TT-MCP Google Reauth' task (cc reauth replaces it)." }
if ($Start) { Start-ScheduledTask -TaskName $name; Write-Host "Started '$name'." }
