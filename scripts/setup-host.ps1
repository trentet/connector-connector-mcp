<#
  One-time (idempotent) host setup for cc, one environment per run:

    .\scripts\setup-host.ps1 -Environment test
    .\scripts\setup-host.ps1 -Environment production

  Creates (or reuses): the Cloudflare tunnel, its DNS route, %LOCALAPPDATA%\HELM\connector-connector-mcp\<env>\tunnel-config.yml,
  and <env>\secrets\connector.env containing a freshly generated CC_MCP_BEARER_TOKEN (never printed, never overwritten if present).
  Also copies cloudflared.exe to <base>\tools\. Does NOT deploy or start anything: see scripts\deploy.mjs and scripts\install-tasks.ps1.
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet("production", "test")][string]$Environment,
    [string]$ChromeProfile = "D:\GDrive\HELM\DEV-PROJECTS\Connectors\Remote Terminal MCP Connector\Repos\helm-terminal-mcp\tools\browser-profile"
)
$ErrorActionPreference = "Stop"
$spec = @{
    production = @{ Tunnel = "cc-mcp";      Hostname = "cc.trentt.me";      Port = 8810 }
    test       = @{ Tunnel = "cc-mcp-test"; Hostname = "cc-test.trentt.me"; Port = 8811 }
}[$Environment]
$base = Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp"
$envDir = Join-Path $base $Environment
$secretsDir = Join-Path $envDir "secrets"
$toolsDir = Join-Path $base "tools"
foreach ($d in $base, $envDir, $secretsDir, $toolsDir) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

# cloudflared
$cf = Join-Path $toolsDir "cloudflared.exe"
if (-not (Test-Path $cf)) {
    $src = if ($env:CLOUDFLARED_PATH -and (Test-Path $env:CLOUDFLARED_PATH)) { $env:CLOUDFLARED_PATH } else {
        Get-ChildItem "D:\GDrive\HELM\DEV-PROJECTS\Connectors" -Recurse -Filter cloudflared.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    if (-not $src) { throw "cloudflared.exe not found; set CLOUDFLARED_PATH" }
    Copy-Item $src $cf
}

function Invoke-Cf { param([string[]]$CfArgs) $ErrorActionPreference = "Continue"; $out = (& $cf @CfArgs 2>&1 | Out-String); return @{ Code = $LASTEXITCODE; Out = $out } }

# tunnel (reuse if it exists)
function Get-Tunnel {
    $ErrorActionPreference = "Continue"
    $json = (& $cf tunnel list --output json 2>$null | Out-String).Trim()   # stdout only: warnings go to stderr
    if ($json) { return ($json | ConvertFrom-Json) | Where-Object { $_.name -eq $spec.Tunnel } }
}
$t = Get-Tunnel
if (-not $t) {
    $r = Invoke-Cf @("tunnel", "create", $spec.Tunnel)
    if ($r.Code -ne 0) { throw "tunnel create failed: $($r.Out)" }
    $t = Get-Tunnel
}
if (-not $t) { throw "tunnel $($spec.Tunnel) not found after create" }
$id = $t.id
$credFile = Join-Path $env:USERPROFILE ".cloudflared\$id.json"
if (-not (Test-Path $credFile)) { throw "tunnel credentials file missing: $credFile" }

# DNS route (idempotent: 'already exists' is fine)
$r = Invoke-Cf @("tunnel", "route", "dns", $spec.Tunnel, $spec.Hostname)
if ($r.Code -ne 0 -and $r.Out -notmatch "already exists|A, AAAA, or CNAME record") { throw "route dns failed: $($r.Out)" }

# tunnel config
$cfgPath = Join-Path $envDir "tunnel-config.yml"
@"
tunnel: $id
credentials-file: $credFile
ingress:
  - hostname: $($spec.Hostname)
    service: http://127.0.0.1:$($spec.Port)
  - service: http_status:404
"@ | Set-Content -Path $cfgPath -Encoding ascii

# secrets (never overwrite, never print)
$secrets = Join-Path $secretsDir "connector.env"
if (-not (Test-Path $secrets)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    "CC_MCP_BEARER_TOKEN=$token`nCC_CHROME_PROFILE=$ChromeProfile`n" | Set-Content -Path $secrets -Encoding ascii
    Write-Host "Created $secrets (token generated, not shown)."
} else { Write-Host "Kept existing $secrets" }

Write-Host ("OK [{0}]: tunnel {1} ({2}), dns {3} -> 127.0.0.1:{4}, config {5}" -f $Environment, $spec.Tunnel, $id, $spec.Hostname, $spec.Port, $cfgPath)
