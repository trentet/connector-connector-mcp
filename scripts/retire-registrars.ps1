<#
  One-off Phase 6 helper: in FRESH CLONES under -Work, replace the registration steps of the connector repos' setup scripts with a pointer
  to cc, remove the per-repo registrar folders (tracked ones), and add the adoption note to each README. Never touches anyone's working folders.
  Verifies every edited .ps1 still parses. Run, review `git diff`, then commit/push from each clone.
#>
param([string]$Work = "C:\Users\Trent\cc-cleanup")
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-L($p) { [System.IO.File]::ReadAllText($p).Split(@("`r`n"), [System.StringSplitOptions]::None) }
function Write-L($p, $lines) { [System.IO.File]::WriteAllText($p, ($lines -join "`r`n"), $utf8) }
function Find-Idx($lines, $pattern, $from = 0) { for ($i = $from; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $pattern) { return $i } }; throw "anchor not found: $pattern" }
function Splice($lines, $start, $end, $new) { @($lines[0..($start - 1)]) + $new + @($lines[($end + 1)..($lines.Count - 1)]) }
function Test-Parse($p) { $errs = $null; [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs) | Out-Null; if ($errs.Count) { throw "PARSE ERROR in ${p}: $($errs[0].Message)" } }

# ---- TT-MCP\remote-setup.ps1
$f = Join-Path $Work "TT-MCP\remote-setup.ps1"; $L = Read-L $f
$i = Find-Idx $L '^# Confirmed live 2026-09-08 by the operator'
$L = Splice $L $i ($i + 3) @()
$s = Find-Idx $L '^# A named tunnel''s URL is stable and the bearer token'
$d = Find-Idx $L '^\s+Write-Host "=== Done\. ===" -ForegroundColor Green' $s
$e = Find-Idx $L '^}$' $d
$L = Splice $L $s $e @(
  '# Registering this connector on claude.ai / ChatGPT / Grok is NOT done by this script any more.',
  '# connector-connector-mcp ("cc") does it for every connector, on all three platforms, with one registry and one code path:',
  '#     cc add helm-drive --platform all   then   cc verify helm-drive --platform all',
  '# See https://github.com/trentet/connector-connector-mcp (docs/ADOPTION.md). Connection info is still written to $infoPath above.',
  'Write-Host ""',
  'Write-Host "=== Done. The server and tunnel are up. ===" -ForegroundColor Green',
  'Write-Host "Connector URL: $mcpUrl" -ForegroundColor White',
  'Write-Host "Register it on claude.ai / ChatGPT / Grok with connector-connector-mcp:  cc add helm-drive --platform all" -ForegroundColor DarkGray')
$a = Find-Idx $L '^if \(\$usingNamedTunnel\) \{$' ($s + 8)
$b = Find-Idx $L '^}$' ($a + 1); $b = Find-Idx $L '^}$' ($b + 0)
# the if/else that spells out re-registration behaviour: replace the whole if..else..} with one pointer
$endElse = Find-Idx $L '^\}$' ($a + 2)
$L = Splice $L $a $endElse @(
  'Write-Host "set up. Registering the connector on claude.ai / ChatGPT / Grok is done by connector-connector-mcp, not by this script:" -ForegroundColor DarkGray',
  'Write-Host "    cc add helm-drive --platform all     (https://github.com/trentet/connector-connector-mcp)" -ForegroundColor DarkGray')
Write-L $f $L; Test-Parse $f

# ---- roku-mcp\remote-setup.ps1
$f = Join-Path $Work "roku-mcp\remote-setup.ps1"; $L = Read-L $f
$i = Find-Idx $L '^Next \(manual, one time\): register this URL as a custom connector at'
$L = Splice $L $i ($i + 2) @('Next: register this URL on claude.ai / ChatGPT / Grok with connector-connector-mcp (https://github.com/trentet/connector-connector-mcp):', 'add a registry entry for roku-mcp there, then:  cc add roku-mcp --platform all   (see its docs/ADOPTION.md)')
$j = Find-Idx $L '^Write-Log "See \$infoPath for the URL/token, and this repo'
$L = Splice $L $j ($j + 1) @('Write-Log "See $infoPath for the URL/token. Register it with connector-connector-mcp:  cc add roku-mcp --platform all"')
Write-L $f $L; Test-Parse $f

# ---- helm-terminal-mcp\setup.ps1
$f = Join-Path $Work "helm-terminal-mcp\setup.ps1"; $L = Read-L $f
$a = Find-Idx $L '^\s+# 10\. The one thing that genuinely cannot be scripted'
$fin = Find-Idx $L '^\} finally \{' $a
$L = Splice $L $a ($fin - 1) @(
  '    # 10. Registering this connector on claude.ai / ChatGPT / Grok is done by connector-connector-mcp ("cc"), not by this script.',
  '    Log "Register or update it with:  cc add helm-shell --platform all   (https://github.com/trentet/connector-connector-mcp)"')
Write-L $f $L; Test-Parse $f

# ---- remove tracked per-repo registrar folders
foreach ($r in "vault-mcp", "helm-terminal-mcp") {
    $dir = Join-Path $Work "$r\scripts\register-connector"
    if (Test-Path $dir) { git -C (Join-Path $Work $r) rm -r -q scripts/register-connector; Write-Host "git rm -r $r\scripts\register-connector" }
}

# ---- README adoption note
$notes = @{ "TT-MCP" = "helm-drive"; "roku-mcp" = "roku-mcp"; "helm-terminal-mcp" = "helm-shell"; "vault-mcp" = "vault-mcp"; "helm-audio-mcp" = "helm-audio-mcp" }
foreach ($r in $notes.Keys) {
    $rf = Join-Path $Work "$r\README.md"; $txt = [System.IO.File]::ReadAllText($rf)
    if ($txt -notmatch 'connector-connector-mcp') {
        $nl = if ($txt -match "`r`n") { "`r`n" } else { "`n" }
        $add = "$nl## Registering this connector$nl$nl" +
          "Registering this connector on claude.ai / ChatGPT / Grok is done by [connector-connector-mcp](https://github.com/trentet/connector-connector-mcp) (cc), not by a script in this repo. Do not add ``register-connector`` scripts here.$nl" +
          "Add or update this connector's entry in cc's ``registry/connectors.json``, then run ``cc add $($notes[$r]) --platform all`` and ``cc verify $($notes[$r]) --platform all``.$nl"
        [System.IO.File]::WriteAllText($rf, $txt.TrimEnd() + $nl + $add, $utf8)
    }
}
Write-Host "Done. Review with: git -C <clone> diff --stat"
