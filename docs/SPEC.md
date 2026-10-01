# SPEC -- connector-connector-mcp v0.2 (APPROVED 2026-10-01)

Status: plan approved by operator 2026-10-01. Language: TypeScript. Server hostname: cc.trentt.me.
Owner decision (operator, 2026-10-01): ONE universal tool registers ANY connector on ANY platform
(claude.ai, ChatGPT, Grok). Connector repos hold NO registration scripts.

## 1. Architecture

    connector-connector-mcp/
      bin/cc                      single entry point (CLI)  ->  `cc <op> <connector|--all> --platform <p|all>`
      src/
        core/                     registry loader, secret resolver, redaction, orchestrator, result model
        browser/                  Patchright over CDP (the ONLY place a browser is touched)
        adapters/{claude,chatgpt,grok}/   one adapter per platform, same interface
        server/                   MCP server front door (Streamable HTTP, token-gated)
      data/
        selectors/{claude,chatgpt,grok}.json   flow + selector maps (data, not code; drift is fixed here)
      registry/connectors.json    connector definitions: NO secret values, only references
      test/  deploy/  docs/

Rules that make it universal:
- The runner knows operations and platforms, never a specific connector. Connector facts live only in
  `registry/connectors.json`. A test fails the build if any seeded connector's id, name, host or env var
  appears in `src/`.
- Adapters implement one interface: `probe, list, add, remove, update, verify` (+ `dryRun`). The runner
  dispatches `op x connector x platform`; adding a platform = adding an adapter + a selector file.
- Both front doors (CLI, MCP server) call the same `core.run(request)`; no logic lives in either.
- Idempotent: `add` on an existing connector is a no-op unless `--if-existing update|fail`.

## 2. Connector definition (registry)
`id, name, description, url (literal | template), auth {mode: header|tokenUrl|oauth|none, headerName?},
secrets {name: ref}, platforms[]`. Secret refs: `envFile(path,key) | env(var) | vault(label) |
fileRegex | literal(non-secret only)`. Reuses the source-type design of the existing ChatGPT registrar.
Secrets are resolved in-process at run time; never stored, logged, echoed, or returned (tokenized URLs
redacted in all output). MCP callers pass a registry id, not a token.

## 3. Operations
`add, remove, update, list, verify, dry-run, probe`. `verify` = confirm on the live platform that the
connector is registered AND connected (tools discovered), not merely that the add form submitted.
Failure => screenshot to `artifacts/` (redacted), non-zero exit, structured error.

## 4. Platform notes (from existing assets + research)
- claude.ai: direct URL https://claude.ai/customize/connectors?modal=add-custom-connector, header
  `x-api-key`. Never navigate via Settings. Port logic from the existing Claude registrar, strip all hardcoding.
- ChatGPT: noauth tokenized URL or OAuth (no custom headers). Port from helm-local chatgpt registrar.
- Grok: grok.com/connectors -> New Connector -> Custom -> server URL -> auth (per xAI docs dated
  2026-07-17, from the 2026-09-20 fetch). LIVE PROBE 2026-10-01: login works from the vault entry via
  accounts.x.ai/sign-in -> "Login with email" -> email -> password (no 2FA seen). The New Connector > Custom
  form has ONLY Name + Server URL (placeholder https://mcp.example.com/sse) + Cancel/Add Connector: NO header
  or auth field. So Grok, like ChatGPT, takes auth only via the URL (tokenized URL) or whatever OAuth the server
  triggers after Add. OPEN: whether Grok accepts Streamable HTTP (/mcp) or needs SSE: settled by the P3 exit test.
  Research note: Drive THREADS/ "RESEARCH -- Grok custom MCP connector".
- Browser: attach to a normally launched Chrome over CDP with a dedicated persistent profile; never
  launchPersistentContext; one clean tab per run; quote paths with spaces; never via helm-workflow-runner.
- Login: vault backing store (bw serve) resolved inside this process (pattern: patchright-mcp
  src/vaultClient.ts). Human login only as last resort.

## 4a. Guardrail against per-repo copies
- This repo's CLAUDE.md states the rule. `docs/ADOPTION.md` gives a 5-line snippet for every connector
  repo: "do not add registration scripts; register via connector-connector-mcp".
- `cc audit --scan <repo-root>` lists registration-script look-alikes in other repos (used at cleanup).

## 5. Phases and exit criteria
P0 Probe/research. Live read-only probes of the three UIs; Grok add-flow documented in Drive.
   Exit: written findings in Drive for all three, incl. Grok auth modes.
P1 Core. Registry schema+validation, secret resolver (all source types), redaction, result model, CLI
   skeleton, `--dry-run`. Exit: unit tests green; dry-run resolves all seeded connectors with zero secret
   leakage (test greps output).
P2 Browser layer. CDP attach, profile mgmt, tab hygiene, screenshot-on-failure, vault login.
   Exit: attaches to the logged-in Chrome and reaches each platform's connectors page unattended.
P3 Adapters. chatgpt (port), claude (port), grok (new), each with list/verify/add/remove/update.
   Exit per platform: add -> verify -> remove -> verify, twice (idempotency), on a throwaway test connector.
P4 MCP server + deploy. Streamable HTTP, token gate, tunnel + PowerShell watchdog scheduled task,
   dev+test envs, health endpoint (helm-audio-mcp pattern). Exit: CLI and MCP produce identical results.
P5 Seed + parity. Seed HELM Drive, HELM Shell, Vault MCP, helm-audio-mcp, patchright-mcp. Exit: new tool
   reproduces the current registered state for each, verified by `verify`.
P6 Retire old copies (vault-mcp, helm-terminal-mcp, helm-audio-mcp Claude registrars; helm-local test copy;
   helm-local ChatGPT registrar). Only after P5 parity and explicit operator go-ahead.

## 6. Decisions and open items
Decided (2026-10-01): plan approved; TypeScript; hostname cc.trentt.me; Grok plan is standard $30 (not
Business/Enterprise, so no admin provisioning expected; confirm in P0 probe).
Grok login: operator uses grok.com EMAIL login, NOT "Sign in with Google", even though the address is a
Gmail. The Grok adapter must use the email/password path.
OPEN:
1. Vault entry for the grok.com email login. `vault_list_refs` (2026-10-01) shows only: DSM-*, DSM-Connect-
   deployment-secrets, "Google Account (trenterrolthomas@gmail.com)", KnottyAI-PC. No Grok entry. Operator
   to create one (or name an existing label). Also confirm whether claude.ai and ChatGPT logins use the
   Google account entry or separate entries.
   RESOLVED part (2026-10-01): claude.ai and ChatGPT logins use the vault entry
   "Google Account (trenterrolthomas@gmail.com)". Operator has several Gmail accounts, so adapters must
   verify the signed-in account after login and fail on mismatch. Grok: submission link minted via
   vault_request_secret, label "Grok (grok.com email login)", awaiting operator submit (not yet in vault_list_refs).
2. Diff of the three vendored Claude registrars and ChatGPT registrar internals still to be read (P0/P3).

## 7. TO-DO (operator-mandated, do not drop)
FINAL STEP (P6): once cc is built, deployed, and verified on claude.ai, ChatGPT AND Grok with parity for
every seeded connector, CLEAN UP the old per-repo registration scripts so cc is the single source of truth:
vault-mcp, helm-terminal-mcp, helm-audio-mcp scripts/register-connector/ (and D:\GDrive\...\Repos copies),
helm-local\register-test-connector, helm-local\backups\register-connector-accommodation-edit-20260928,
helm-local\chatgpt-register-connectors. Find stragglers with `cc audit --scan`. Add docs/ADOPTION.md
snippet to each connector repo. Confirm with operator before deleting.
