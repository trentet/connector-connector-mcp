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
5. **Browser rules (learned the hard way):** every run drives its OWN Chrome process (one process per connector sequence), attached over CDP to a normally launched
   chrome.exe (NEVER `launchPersistentContext`: claude.ai's anti-automation sends a Playwright-launched persistent context into a challenge/logout loop). Never dump full page text
   (the grok/chatgpt sidebars contain private chat titles); scope snapshots to a dialog.
   **Browser model (src/browser):** every run drives its OWN Chrome process(es), and a call that covers several platforms gives each platform its own worker and its own browser. `CC_PLATFORM_PARALLELISM` says how many run at the same time; the default is 1 (one after another) because it MEASURED slower on the HELM host
   (verify of one connector on all three platforms: 68 to 81 s one after another, 114 to 213 s with all three at once; each cc Chrome burns about 1.7 of the host's 8 cores). Do not raise the default without a fresh measurement. Connectors on one platform always stay sequential, because two adds in one account can race on that platform's list. A browser claims a lane (`lanes.ts`: numbered slot, CDP port = base+index, cross-process lock file, bounded by `CC_MAX_CONCURRENCY`, default 4; a full house waits, then errors clearly),
   clones the sign-in state of the COLD master profile (`CC_BROWSER_MASTER`, default `<helm base>/browser-master`) into a private temp dir (`profile.ts`), launches Chrome on that copy, and on `close()` shuts that Chrome down, deletes the copy and frees the lane.
   Refreshed sessions are merged back cookie by cookie: only the sign-in cookies a healthy browser (every platform it touched still has its sign-in cookie) ROTATED during the run, by a short-lived Chrome that holds the master lock (`mergeCookiesIntoMaster`).
   **Invariants that protect it:** (a) a browser belongs to exactly one run and one platform: never attach to a port you do not hold the lane for, never close or reuse another run's tabs; (b) never open the master with a browser while runs may clone it
   (only `cc browser seed` and the merge do, both under the master lock, and clones refuse a master a foreign Chrome has open); (c) unchanged cookies are never written back, so an older copy cannot overwrite a newer master; (d) nothing in `src/browser` may leave a Chrome, a temp profile or a lane lock behind, on success or on failure;
   (e) lock order is always lane first, then master lock (a merge or seed claims its own lane before taking the master lock, and a run frees its lane before merging), so they cannot deadlock; (f) the old shared Chrome (the HELM browser on 9222, `CC_CHROME_PROFILE`) is not used by cc any more.
   Tests: `test/browser-concurrency.test.ts` runs real Chromium; `test/parallel-platforms.test.ts` covers the runner.
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
`node bin/cc.mjs browser seed|check` (master profile) · `node bin/cc.mjs audit --scan <repo-root>` (finds registration-script look-alikes in other repos).
Host: `CC_BROWSER_MASTER` (cold master profile), `CC_MAX_CONCURRENCY`, `CC_PLATFORM_PARALLELISM`, `CC_TRACE=1` (per-step timings on stderr), `CC_CHROME_PATH`, `CC_DEBUG=1` (redacted step dumps), deploy with `scripts/setup-host.ps1`, `scripts/deploy.mjs`, `scripts/install-tasks.ps1`.
