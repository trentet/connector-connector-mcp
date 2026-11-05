# ChatGPT native plugin Refresh: issue #83

Status: development-only, not deployed. The code uses the existing universal ChatGPT adapter. It does not add connector-specific code, overwrite credentials, or change the already-correct Patchright server contract.

## Source observations (2026-11-05)
- Patchright production and test MCP servers expose browser_open_session with required headless boolean. Calls without this argument fail.
- ChatGPT cached connector tool interface omits headless. It rejects headless as an undeclared parameter, but the server rejects omission.
- OpenAI docs require metadata refresh after MCP schema changes: https://developers.openai.com/plugins/deploy/connect-chatgpt
- HELM CC browser profile cookie check said signed in, but actual navigation to https://chatgpt.com/plugins redirected to /auth/login. A screenshot is stored under C:/ProgramData/HELM/logs/cc-refresh-probe.
- The existing login code uses a one-time HELM Vault SMS entry. New Vault intake was not created because the credential collection tool was refused by the platform safety check. Never reuse previous codes or put credentials into code or Git.

## Change
- src/adapters/chatgptRefresh.ts: bounded native plugin Refresh action with identity guard, direct Refresh or Manage > Refresh, no unexpected approvals and stale-toast protection.
- src/adapters/chatgpt.ts: wires update through existing browser session, screenshot-on-error guard and connection check. Reports uncertainty when the page does not confirm the action.
- data/selectors/chatgpt.json: hypothesized Refresh UI labels, marked UNVERIFIED because the page redirected to login.
- test/chatgpt-refresh.test.ts: eight synthetic tests: target identity, wrong host, ambiguous controls, review dialog, stale success toast.

## Tests and outstanding gates
- npm run typecheck: PASS.
- npx vitest run test/chatgpt-refresh.test.ts: 8 passed, 0 failed.
- Full npm test attempt: BLOCKED before execution, not passed.
- No live ChatGPT Refresh click occurred; cached schema is not verified updated.
- Do not deploy to production until the live Plugins page can be inspected after direct authorized sign-in, any selector drift fixed, full tests complete, and account-controller approval obtained under HELM engineering rules.

## Direct one-time code follow-up (operator direction, 5 November 2026)
The operator requires a direct, non-Vault code handoff, coordinated just before a fresh code is sent. Vault remains appropriate for durable username/password credential pairs, but **must not be required** for a transient login code. Old codes must not be replayed.

The adapter now supports CC_CHATGPT_OTP_FILE, an explicit host-side, per-attempt absolute path to a disposable six-digit handoff. The adapter logs only CHATGPT_OTP_FIELD_READY when the actual verification field is present, polls for the short-lived input, deletes that input before filling the browser field, and never logs the value. The previous Vault path is retained for compatibility, but direct-mode invocation never calls it for OTP. The operator controls when to create the code input; do not prefill or store codes in this repository.

Type-check and 12 focused tests passed, including single consumption, invalid-code rejection, absent-file expiry, wrong plugin, and stale-refresh confirmation. Live login and refresh remain unverified until an actual fresh code is entered and the target UI state is read back.
