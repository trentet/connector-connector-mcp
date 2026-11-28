# Optional: staging `cc reauth` weekly through a Claude Routine + helm-workflow-runner

The Scheduled Task `cc-mcp Google Reauth` (every day, renewing a connector only once its last renewal is 3 days old; `scripts/install-reauth-task.ps1`) is the primary scheduler for `cc reauth` and needs
nothing else. If the operator also wants a Claude Routine that stages a one-approval helm-workflow-runner job each week - this
is the prompt for it. Since 2026-10-03 it is a Routine of its own, **"cc weekly Google reauth (ALL Google-OAuth connectors)"** (`trig_014PARasGUsixL4eX1ZLPvuM`, Fridays 03:07 America/Denver), bound to a
home thread rooted in THIS repo (session `session_01EV1VWNSe2bGEu2eEoX8NjR`), so its instructions are edited from here and nothing about it lives in any connector repo. It runs
`cc reauth --all`, i.e. **every production registry entry that has a `googleOAuth` block - for ALL connectors, not a fixed pair**: the operator keeps every Google-using connector's
OAuth client in Testing status (no Production verification, by choice), so every one of them needs this weekly. A connector is covered the moment its registry entry has a block.
The earlier Routines ("helm-drive-mcp weekly Google reauth", `trig_01StEcUJkmvxpfvYYHUh1nMZ`, bound to a helm-drive-mcp-rooted thread with a stale patchright-mcp prompt) is retired: renamed and paused,
not deleted, because deleting a Routine also deletes the sessions it started. A Routine's instructions can only be edited from the thread it posts into; to change the prompt below,
change it here AND re-create the Routine from this thread (or ask in the home thread).

**Coverage on 2026-10-04** (audit of all 32 repos under github.com/trentet by `cc audit --google --github trentet`, which now runs after every scheduled renewal):
registry entries with a `googleOAuth` block: `helm-drive` (repo `trentet/helm-drive-mcp`), `helm-audio-mcp` (repo `trentet/helm-audio-mcp`), `helm-vision-mcp` (repo `trentet/helm-vision-mcp`, KNOTTYAI-PC, added 2026-10-04 once it was running) `helm-handoff-robot` (repo `trentet/helm-handoff`, Google-only: platforms `[]`, no url; the handoff orchestrator's Drive grant, token delivered to the NAS login `helm-renew`, health with `expectRenewedAt`, no restart; added 2026-10-11, Refs #45) and the test-tier entries. Every other repo is accounted for:
- `trentet/patchright-mcp`: exempt, a leftover. Its `google-auth-library` dependency exists only for `scripts/helm-drive-mcp-weekly-reauth.ts`, the old helm-drive-mcp renewal that `cc reauth` replaced (nothing schedules it any more; the only
  Google reauth task on the host is `cc-mcp Google Reauth`). patchright-mcp itself holds no Google grant. Removing that script and the dependency from the patchright-mcp repo is the remaining cleanup there.
- `trentet/connector-connector-mcp` (the renewer itself) and `trentet/dsm-connect` (its own OAuth 2.1 server, no Google API): exempt, with reasons in `registry/connectors.json` (`googleOAuthExemptions`).
- No other repo has a Google dependency or token files.
A new Google connector can no longer be left out silently: every run of `scripts/run-reauth.ps1` ends with the coverage guard, and a repo that uses Google OAuth but has neither a `googleOAuth` block nor an exemption makes it
log `GOOGLE COVERAGE GAP` and exit 3. A registry entry with a `googleOAuth` block must also carry `repo` (the guard matches repos to entries by it).

Both schedulers can coexist: cc takes a per-connector lock, so two renewals never run at once (the second is reported as `skipped`).

## Prompt

Weekly Google OAuth reauth for EVERY connector that holds a Google refresh token. The operator keeps every Google-using connector's OAuth client in Testing publishing status on
purpose (they have explicitly rejected Production verification), and Google expires Testing refresh tokens after exactly 7 days, so all of them must be renewed on a schedule. The
renewal lives in trentet/connector-connector-mcp ("cc") as `cc reauth` (cc issue #33) precisely because it must work for ALL connectors: it renews every registry entry that has a
`googleOAuth` block, so a connector is covered the moment its registry entry has one. Do NOT reintroduce any reauth/renew code or Google-consent automation into any individual
connector repo. Standing approval: auto-arm every week without asking. Test-tier connectors are on-demand and not part of this run.

1. Job id `<today's-date>-google-reauth-<random hex4>`.
2. On the host, confirm cc's deployed copy is present and healthy (`Test-Path "$env:LOCALAPPDATA\HELM\connector-connector-mcp\deploy\production\bin\cc.mjs"`;
   `http://127.0.0.1:8810/health` is 200) and run `node bin\cc.mjs reauth --all --dry-run` in that folder: every line must read `dry-run`; note which connector ids it lists. A line reading `skipped - not a renewer on <host>` is expected for helm-handoff-robot on the W540 (only KNOTTYAI-PC renews it) and is not a failure.
   Do not redeploy cc from here.
3. Create `D:\GDrive\HELM\DEV-PROJECTS\Local Utilities\helm-workflow-runner\workflow-runner\jobs\<job-id>\` with:
   - `manifest.json`: `{ "id": "<job-id>", "requestedBy": "connector-connector-mcp (cc reauth) - recurring weekly Google OAuth reauth Routine (auto-armed, standing approval)", "description": "Runs node bin\\cc.mjs reauth --all from cc's deployed copy (every production connector with a googleOAuth block). Manual fallback per connector: its own manual re-auth (refresh-token.bat in helm-drive-mcp; README setup step 3 in helm-audio-mcp; see each connector's README).", "resourceLocks": ["cc-reauth"], "steps": [ { "name": "run-cc-reauth", "script": "run-cc-reauth.ps1", "timeoutSeconds": 900, "maxRetries": 1, "retryBackoffSeconds": 120 } ] }`
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
7. Coverage check, every run: `node bin\cc.mjs audit --google --github trentet` in the same folder (exit 1 = a repo uses Google OAuth with no registry `googleOAuth` block and no exemption; `PENDING` lines are
   known and not failures). If it prints `UNCOVERED`, tell the operator once which repo and that its registry entry needs a `googleOAuth` block (and a `repo` field) in cc; repeat `PENDING` lines in one line.
