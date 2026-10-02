<#
  Registers the cc server and tunnel watchdogs as AtLogOn Scheduled Tasks for one environment (idempotent; replaces same-named tasks),
  pointing at the DEPLOYED copy's scripts so a redeploy takes effect on the next restart.

    .\scripts\install-tasks.ps1 -Environment test [-Start]
#>
param([Parameter(Mandatory = $true)][ValidateSet("production", "test")][string]$Environment, [switch]$Start)
$ErrorActionPreference = "Stop"
$base = Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp"
$deploy = Join-Path $base "deploy\$Environment"
$prefix = if ($Environment -eq "production") { "cc-mcp" } else { "cc-mcp-test" }
foreach ($kind in "Server", "Tunnel") {
    $script = Join-Path $deploy ("scripts\run-{0}.ps1" -f $kind.ToLower())
    if (-not (Test-Path $script)) { throw "$script not found: deploy first (node scripts\deploy.mjs $Environment)" }
    $name = "$prefix $kind"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Environment $Environment"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "Registered '$name' (AtLogOn)."
    if ($Start) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName $name; Write-Host "Started '$name'." }
}
