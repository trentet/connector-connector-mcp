# connector-connector-mcp ("cc") — rules for any session working here

cc is the SINGLE source of truth for adding, removing, updating, listing and verifying MCP connectors on claude.ai, ChatGPT and Grok.
Connector repos must NOT carry their own registration scripts. If you are asked to register a connector, use cc; do not write a script.

## Hard rules
1. **Nothing connector-specific in `src/`.** Connector facts (id, name, URLs, secret references, enabled platforms) live ONLY in `registry/connectors.json`.
   `test/core.test.ts` ("universality") fails the build if a seeded connector's id/name/host/env var appears in `src/`. Never weaken that test; fix the code.
2. **Secrets: references only.** The registry stores `envFile | env | fileRegex | vault | template` sources, never values. Never print, log, return or screenshot a secret
   or a tokenized URL. All output goes through `Redactor`. MCP tools take registry ids only (the server rejects unknown arguments).
3. **Platform UI facts live in `data/selectors/<platform>.json`**, not buried in code. When a UI drifts, fix the data file or the adapter step, then re-run the platform's exit test.
4. **A result is only real if read back.** `add` is not done until `verify` sees it; `remove` is not done until a fresh list no longer shows it. Adapters must never report success on a hunch;
   prefer `error` over a false `ok`. Poll for asynchronous registration instead of reading once.
5. **Browser rules (learned the hard way):** attach to the normally launched Chrome over CDP (never `launchPersistentContext`); never close the last tab (Chrome exits);
   one clean tab per run; never dump full page text (the grok/chatgpt sidebars contain private chat titles); scope snapshots to a dialog.
   **Browser lifetime:** a Chrome that cc itself launched (recorded in `<profile>\cc-launched.json`) is closed when the run ends, unless another tab is in use.
   A Chrome somebody else started (the shared HELM browser, the operator's own) is attached to and left running. Never add code that leaves a cc-launched browser idling. `CC_KEEP_BROWSER=1` opts out for debugging.
6. **Logins** come from the vault inside this process (`bw serve`), never via a vault MCP tool call. ChatGPT's SMS code goes through a one-time vault entry (`ChatGPT SMS code`).
7. **Throwaway test connector:** `registry/selftest.json` (`cc-selftest`). Exit test per platform = add → verify → remove → verify, twice, then confirm real connectors are untouched.

## Test connectors are on-demand (operator policy)
Connectors with `"tier": "test"` (helm-audio-mcp-test, helm-drive-mcp-test, patchright-mcp-test, connector-connector-test) must NOT stay registered on the platforms
unless someone is actively developing or testing them. `--all` / `"*"` skips them unless `--include-test` (CLI) / `include_test` (MCP). The operator or any thread may ask
cc to bring one up (`cc add helm-audio-mcp-test --platform all`) or take it down (`cc remove helm-audio-mcp-test --platform all`) at will; naming it explicitly always works.
After a test session ends, remove it again and run `cc list --platform all` to confirm.

Promotion rule (operator, 2026-10-02): test is for development and functionality verification, never a standing parallel deployment. The moment a connector's production tier is deployed and verified working (see the per-platform verified-state definitions below) on every platform it's registered on, its matching test-tier connector comes down as part of that same promotion - this is not optional and not something to wait to be asked about a second time once the operator has set this expectation. Confirmed-live case: fleet-connect-test stayed up through fleet-connect's full deploy-and-verify cycle (needed to prove the server before cutover), then was removed from all 3 platforms the moment fleet-connect (production) verified ok everywhere.

## What "verified" means per platform
- **Claude:** the connector row exists and shows Connected.
- **Grok:** the connector is in the Connected list.
- **ChatGPT:** the connector is in the Installed list AND its own page shows Connected. Installing alone is not enough: ChatGPT also needs its Connect step (button, then confirmation dialog), which `cc add` performs and `cc add --if-existing skip` repairs.
  ChatGPT lists no discovered tools anywhere on the page (probed 2026-10-02), so cc cannot prove a tool scan; it only proves the connection state ChatGPT displays.
- `--platform` takes one or more platforms, or `all`: `--platform chatgpt grok`.

## Layout
`bin/cc.mjs` CLI · `src/core` registry/secrets/redaction/runner · `src/adapters/{claude,chatgpt,grok}.ts` · `src/browser` · `src/server` MCP front door ·
`data/selectors` · `registry` · `scripts` deploy/start/tunnel/tasks · `tools/probe` read-only diagnostics · `docs/SPEC.md`.

## Commands
`npm test` · `npm run build` · `node bin/cc.mjs <add|remove|update|verify|list|probe> [ids|--all] --platform <claude|chatgpt|grok ...>|all [--dry-run] [--registry <path>]` ·
`node bin/cc.mjs audit --scan <repo-root>` (finds registration-script look-alikes in other repos).
Host: `CC_CHROME_PROFILE` (debug Chrome profile), `CC_DEBUG=1` (redacted step dumps), deploy with `scripts/setup-host.ps1`, `scripts/deploy.mjs`, `scripts/install-tasks.ps1`.
