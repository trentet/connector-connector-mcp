# Optional: staging `cc reauth` weekly through a Claude Routine + helm-workflow-runner

The Scheduled Task `cc-mcp Google Reauth` (every 5 days, `scripts/install-reauth-task.ps1`) is the primary scheduler for `cc reauth` and needs
nothing else. If the operator also wants a Claude Routine that stages a one-approval helm-workflow-runner job each week - this
is the prompt for it. Since 2026-10-03 it is a Routine of its own, **"cc weekly Google reauth (ALL Google-OAuth connectors)"** (`trig_014PARasGUsixL4eX1ZLPvuM`, Fridays 03:07 America/Denver), bound to a
home thread rooted in THIS repo (session `session_01EV1VWNSe2bGEu2eEoX8NjR`), so its instructions are edited from here and nothing about it lives in any connector repo. It runs
`cc reauth --all`, i.e. **every production registry entry that has a `googleOAuth` block - for ALL connectors, not a fixed pair**: the operator keeps every Google-using connector's
OAuth client in Testing status (no Production verification, by choice), so every one of them needs this weekly. A connector is covered the moment its registry entry has a block.
The earlier Routines ("TT-MCP weekly Google reauth", `trig_01StEcUJkmvxpfvYYHUh1nMZ`, bound to a TT-MCP-rooted thread with a stale patchright-mcp prompt) is retired: renamed and paused,
not deleted, because deleting a Routine also deletes the sessions it started. A Routine's instructions can only be edited from the thread it posts into; to change the prompt below,
change it here AND re-create the Routine from this thread (or ask in the home thread).

**Coverage on 2026-10-03:** registry entries with a `googleOAuth` block: `helm-drive` (TT-MCP), `helm-audio-mcp` (+ the two test-tier entries). **Not covered:** `helm-vision-mcp`
(uses `googleapis`, has no registry entry); `patchright-mcp` has `google-auth-library` in its package.json (purpose unchecked). Each needs a registry entry with a `googleOAuth`
block (and, for vision, a decision on where its token lives and how it restarts) before it is renewed. The Routine's last step reports any such gap once per run.

Both schedulers can coexist: cc takes a per-connector lock, so two renewals never run at once (the second is reported as `skipped`).

## Prompt

Weekly Google OAuth reauth for EVERY connector that holds a Google refresh token. The operator keeps every Google-using connector's OAuth client in Testing publishing status on
purpose (they have explicitly rejected Production verification), and Google expires Testing refresh tokens after exactly 7 days, so all of them must be renewed on a schedule. The
renewal lives in trentet/connector-connector-mcp ("cc") as `cc reauth` (cc issue #33) precisely because it must work for ALL connectors: it renews every registry entry that has a
`googleOAuth` block, so a connector is covered the moment its registry entry has one. Do NOT reintroduce any reauth/renew code or Google-consent automation into any individual
connector repo. Standing approval: auto-arm every week without asking. Test-tier connectors are on-demand and not part of this run.

1. Job id `<today's-date>-google-reauth-<random hex4>`.
2. Via mcp__HELM_Shell, confirm cc's deployed copy is present and healthy (`Test-Path "$env:LOCALAPPDATA\HELM\connector-connector-mcp\deploy\production\bin\cc.mjs"`;
   `http://127.0.0.1:8810/health` is 200) and run `node bin\cc.mjs reauth --all --dry-run` in that folder: every line must read `dry-run`; note which connector ids it lists.
   Do not redeploy cc from here.
3. Create `D:\GDrive\HELM\DEV-PROJECTS\Local Utilities\helm-workflow-runner\workflow-runner\jobs\<job-id>\` with:
   - `manifest.json`: `{ "id": "<job-id>", "requestedBy": "connector-connector-mcp (cc reauth) - recurring weekly Google OAuth reauth Routine (auto-armed, standing approval)", "description": "Runs node bin\\cc.mjs reauth --all from cc's deployed copy (every production connector with a googleOAuth block). Manual fallback per connector: its own manual re-auth (refresh-token.bat in TT-MCP; README setup step 3 in helm-audio-mcp; see each connector's README).", "resourceLocks": ["cc-reauth"], "steps": [ { "name": "run-cc-reauth", "script": "run-cc-reauth.ps1", "timeoutSeconds": 900, "maxRetries": 1, "retryBackoffSeconds": 120 } ] }`
   - `run-cc-reauth.ps1`:
     ```powershell
     Set-Location (Join-Path $env:LOCALAPPDATA "HELM\connector-connector-mcp\deploy\production")
     node bin\cc.mjs reauth --all
     exit $LASTEXITCODE
     ```
   - then an empty `.ready` file LAST, then `armed.json`: `{"armedAt": "<now UTC ISO 8601>", "expiresAt": "<now+4h>"}`.
4. The "HELM Workflow Runner" Scheduled Task picks it up (ticks every 2 minutes). Poll `workflow-runner\state\<job-id>.json` `status` every ~30 s for up to ~15 minutes until
   done / failed / cancelled / killed / blocked-id-collision.
5. If `done`: confirm from cc's `%LOCALAPPDATA%\HELM\connector-connector-mcp\logs\reauth.log` that every connector id listed by the dry run shows `ok` for this run; stay quiet.
6. If it fails or never finishes, or any connector shows anything but ok: read the job log, the step's `.err.log` and cc's `reauth.log` (redacted; says which step failed: consent,
   scopes, delivery, restart, health). A failure is cc's to fix (in its own repo and flow), not the connector's. Otherwise tell the operator plainly which connector failed and why,
   and that each connector keeps a manual fallback (see its README).
7. Coverage check, every run: if the operator's repos list a Google-OAuth connector that the dry run did NOT list (for example trentet/helm-vision-mcp, which uses googleapis but had no
   registry entry on 2026-10-03), tell the operator once which one is not covered and that its registry entry needs a `googleOAuth` block in cc.
