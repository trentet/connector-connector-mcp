# ChatGPT native plugin Refresh — issue #83

## Result (verified November 5, 2026)

**ChatGPT's live Patchright connector metadata is corrected.** The native **Refresh tools** control on ChatGPT's authenticated plugin-settings detail page was activated in a headful Chrome session. Its network request returned HTTP **200** at `POST /backend-api/aip/connectors/mcp/refresh_actions`. A subsequent authenticated read of the connector metadata returned `browser_open_session` under `actions[0]`, with `params.properties` containing both `attachable` and `headless`, and `params.required` containing **`headless`**.

ChatGPT's cached tool signature inside a conversation can remain older than the refreshed server metadata; a new conversation may be needed for the client to load the new definition.

The built development Connector Connector command `cc update patchright-mcp --platform chatgpt --account main --json` was also tested live and returned `ok: true`, `status: ok`. This repaired the previous `Target plugin is not in Installed list` failure.

**Production release status:** The source repair remains in the isolated development branch and draft PR #85; it has not been deployed or merged into production Connector Connector. No Patchright server settings, credentials, or policy requirements were changed.

## Root cause

The Patchright MCP production server already required an explicit boolean `headless` argument, but ChatGPT's earlier cached tool definition omitted it. The old Connector Connector ChatGPT adapter returned `not-implemented` for Update. The initial repair used ChatGPT's `/plugins` Installed preview, which is capped and did not expose every installed plugin.

The authenticated full list was observed in ChatGPT's **Settings → Plugins** management page. The target detail presented the native **Refresh tools** button. This UI's refresh acknowledgment did not display a reliable accessible success toast, but the native refresh endpoint returned HTTP 200; its action schema was independently read afterward.

## Changes in draft PR #85

- `src/adapters/chatgptRefresh.ts`: strict ChatGPT plugin-detail origin/path guard, plugin identity check, single unambiguous Refresh control, no automatic approval of unexpected dialogs, no stale-toast false positives.
- `src/adapters/chatgpt.ts`: Update now selects the unique matching plugin from the complete Settings plugin list, validates the target management path, waits for the asynchronously rendered exact heading, captures the native refresh response, and reports success only after HTTP 200 or fresh UI confirmation.
- `data/selectors/chatgpt.json`: verified settings URL, refresh-response endpoint path, and native Refresh button labels, keeping platform-specific facts in selector data rather than hardcoding a connector ID into the adapter.
- `src/core/ephemeralOtp.ts`: optional direct ephemeral six-digit-code handoff, removing the temporary input immediately after read. Vault is **not required** for login OTPs; the operator provides a fresh code only once the actual verification field is ready.
- `test/chatgpt-refresh.test.ts` and `test/ephemeral-otp.test.ts`: deterministic fail-closed and direct-code tests.

## Tests and live evidence

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npx vitest run --testTimeout=12000 --reporter=dot`: **233 passed, 17 skipped, 0 failed** (21 passed suites, 1 skipped).
- Live `cc update` integration: **status: ok**; native refresh API acknowledged.
- Readback: **`browser_open_session` has required `headless`**.
- No user verification code value is preserved in this document, the repository, or logs. No tokenized connector URL is documented.

Previous engineering gate: the existing pinned E13 hidden-launch checker checksum differed before this issue's changes. That pinned file was not modified. Production deployment and PR promotion remain subject to HELM's separate controller/governance process.
