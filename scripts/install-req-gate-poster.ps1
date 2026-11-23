<#
  Installs the cc req-gate status poster on the W540 (REQ-G003.AC9): a pinned clone of main under <home>\pinned, and the
  AtLogOn Scheduled Task "cc-req-gate Status Poster" that starts the watchdog hidden (helm-host-kit run-hidden.vbs, E13).
    .\scripts\install-req-gate-poster.ps1 [-Home_ C:\ProgramData\HELM\cc-req-gate] [-Start]
#>
param([string]$Home_ = "C:\ProgramData\HELM\cc-req-gate", [switch]$Start)
$ErrorActionPreference = "Stop"
$pinned = Join-Path $Home_ "pinned"
if (-not (Test-Path (Join-Path $pinned ".git"))) { New-Item -ItemType Directory -Path $Home_ -Force | Out-Null; git clone --quiet https://github.com/trentet/connector-connector-mcp.git $pinned }
git -C $pinned fetch --quiet origin main; git -C $pinned checkout --quiet --detach origin/main
$script = Join-Path $pinned "scripts\run-req-gate-poster.ps1"
if (-not (Test-Path $script)) { throw "$script not found on main yet" }
$name = "cc-req-gate Status Poster"
$hiddenLauncher = 'C:\ProgramData\HELM\tools\host-kit\current\run-hidden.vbs'; if (-not (Test-Path $hiddenLauncher)) { throw "hidden launcher missing: $hiddenLauncher (install helm-host-kit v0.2.0 or newer; engineering standard E13)" }
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$hiddenLauncher`" /wait powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Home_ `"$Home_`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered '$name' (AtLogOn)."
if ($Start) { Start-ScheduledTask -TaskName $name; Write-Host "Started '$name'." }
