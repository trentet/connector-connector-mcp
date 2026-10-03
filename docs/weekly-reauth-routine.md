# Optional: staging `cc reauth` weekly through a Claude Routine + helm-workflow-runner

The Scheduled Task `cc-mcp Google Reauth` (every 5 days, `scripts/install-reauth-task.ps1`) is the primary scheduler for `cc reauth` and needs
nothing else. If the operator also wants the older pattern - a Claude Routine that stages a one-approval helm-workflow-runner job each week - this
is the prompt for it. It replaces the prompt of the "TT-MCP weekly Google reauth" Routine (`trig_01StEcUJkmvxpfvYYHUh1nMZ`), whose old prompt ran a
script in patchright-mcp that was removed on 2026-10-03 (cc#33, patchright-mcp#7); that Routine is **paused** until its own thread (or the operator)
swaps the prompt in, because a Routine's instructions can only be edited from the thread it posts into.

Both schedulers can coexist: cc takes a per-connector lock, so two renewals never run at once (the second is reported as `skipped`).

## Prompt

Weekly Google OAuth reauth for the connectors that hold a Google refresh token (HELM Drive Connector = trentet/TT-MCP, HELM Audio Connector =
trentet/helm-audio-mcp): stage and arm a fresh helm-workflow-runner job that runs connector-connector-mcp's `cc reauth`, so each connector's Google
refresh_token (which Google expires after exactly 7 days in Testing publishing status, by design - the operator has explicitly rejected switching to
Production status) is refreshed before it lapses. The renewal lives in trentet/connector-connector-mcp ("cc") as `cc reauth` (cc issue #33); do NOT
reintroduce any reauth/renew code or Google-consent automation into TT-MCP, helm-audio-mcp or patchright-mcp. Standing approval: auto-arm every week
without asking. Test-tier connectors are on-demand and not part of this run.

1. Job id `<today's-date>-google-reauth-<random hex4>`.
2. Via mcp__HELM_Shell, confirm cc's deployed copy is present and healthy (`Test-Path "$env:LOCALAPPDATA\HELM\connector-connector-mcp\deploy\production\bin\cc.mjs"`;
   `http://127.0.0.1:8810/health` is 200) and run `node bin\cc.mjs reauth helm-drive helm-audio-mcp --dry-run` in that folder: every line must read `dry-run`.
   Do not redeploy cc from here.
3. Create `D:\GDrive\HELM\DEV-PROJECTS\Local Utilities\helm-workflow-runner\workflow-runner\jobs\<job-id>\` with:
   - `manifest.json`: `{ "id": "<job-id>", "requestedBy": "connector-connector-mcp (cc reauth) - recurring weekly Google OAuth reauth Routine (auto-armed, standing approval)", "description": "Runs node bin\\cc.mjs reauth helm-drive helm-audio-mcp from cc's deployed copy. Manual fallback: refresh-token.bat in the TT-MCP repo (Drive), README setup step 3 in helm-audio-mcp (Audio).", "resourceLocks": ["cc-reauth", "tt-mcp-production-token-json", "audio-production-token-json"], "steps": [ { "name": "run-cc-reauth", "script": "run-cc-reauth.ps1", "timeoutSeconds": 600, "maxRetries": 1, "retryBackoffSeconds": 120 } ] }`
   - `run-cc-reauth.ps1`:
     ```powershell
     Set-Location (Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp\deploy\production")
     node bin\cc.mjs reauth helm-drive helm-audio-mcp
     exit $LASTEXITCODE
     ```
   - then an empty `.ready` file LAST, then `armed.json`: `{"armedAt": "<now UTC ISO 8601>", "expiresAt": "<now+4h>"}`.
4. The "HELM Workflow Runner" Scheduled Task picks it up (ticks every 2 minutes). Poll `workflow-runner\state\<job-id>.json` `status` every ~30 s for up to ~10 minutes until
   done / failed / cancelled / killed / blocked-id-collision.
5. If `done`: confirm from cc's `%LOCALAPPDATA%\HELM\connector-connector-mcp\logs\reauth.log` that both `helm-drive: ok` and `helm-audio-mcp: ok` appear for this run; stay quiet.
6. If it fails or never finishes: read the job log, the step's `.err.log` and cc's `reauth.log` (redacted; says which step failed: consent, scopes, delivery, restart, health). A failure is cc's to fix
   (in its own repo and flow), not TT-MCP's, helm-audio-mcp's or patchright-mcp's. Otherwise tell the operator plainly what failed, and that the manual fallback is `refresh-token.bat` in the TT-MCP
   repo (Drive) and README setup step 3 in helm-audio-mcp (Audio).
