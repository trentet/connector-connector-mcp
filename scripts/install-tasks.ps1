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
    # Started through helm-host-kit's hidden launcher: powershell.exe -WindowStyle Hidden still flashes a console in the logged-on session (E13).
    $hiddenLauncher = 'C:\ProgramData\HELM\tools\host-kit\current\run-hidden.vbs'; if (-not (Test-Path $hiddenLauncher)) { throw "hidden launcher missing: $hiddenLauncher (install helm-host-kit v0.2.0 or newer; engineering standard E13)" }
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$hiddenLauncher`" /wait powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Environment $Environment"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "Registered '$name' (AtLogOn)."
    if ($Start) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName $name; Write-Host "Started '$name'." }
}
