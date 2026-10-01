# SPEC -- connector-connector-mcp v0.1 (DRAFT, awaiting operator approval)

Status: draft. No code is built until the operator approves this plan.
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
  2026-07-17, from the 2026-09-20 fetch). Accepted auth modes UNKNOWN: Phase 0 live probe decides.
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

## 6. Open items
1. Grok account/credential and plan tier (admin provisioning applies to Business/Enterprise).
2. Hostname for the server (e.g. connectors.trentt.me) and test env name.
3. Language: TypeScript (matches other connectors) -- recommended.
4. Diff of the three vendored Claude registrars and ChatGPT registrar internals still to be read.
