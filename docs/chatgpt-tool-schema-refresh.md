# ChatGPT custom MCP schema refresh (issue #83)

## Verified failure
On November 5, 2026 CST, ChatGPT exposed an outdated browser_open_session input schema for the installed Patchright connector: optional attachable, but no required headless. Production Patchright (commit 32f3941) requires headless on every browser_open_session request. Live server rejected an empty call with "Required at headless"; ChatGPT's exposed interface rejected headless:true as unknown input.

OpenAI official docs: https://developers.openai.com/plugins/deploy/connect-chatgpt explain that installed custom MCP input metadata must be refreshed through plugin settings.

## Why the fix belongs in Connector Connector
The ChatGPT adapter previously returned not-implemented for update. The source change now supports a targeted metadata Refresh from a plugin's own detail page. It uses the established one-browser-per-run account profile and the screenshot-on-failure guard. It never removes or re-adds a plugin, modifies its endpoint, submits credentials or changes billing.

The refresh control's exact live UI shape has NOT been verified while signed in; data/selectors/chatgpt.json therefore marks refresh.verified=false. Unknown or ambiguous buttons are refused. A clicked Refresh and Connected state do not prove ChatGPT's cached tool schema changed; that requires a new conversation.

## Live authentication gate
The existing saved ChatGPT browser profile still contains a cookie, but navigating to chatgpt.com/plugins redirected to chatgpt.com/auth/login. Source-controlled read-only probe: scripts/probe-chatgpt-refresh.mjs. Evidence screenshot on W540:
C:\ProgramData\HELM\logs\cc-refresh-issue83\login-required-2026-11-05T06-41-24-366Z.png

No login, SMS bypass, plugin click, production deployment or connection removal occurred.

## Exit criteria
1. Obtain a valid ChatGPT login in the approved browser profile.
2. Re-probe to verify exact current UI labels, then mark selectors verified from live evidence.
3. Promote the change only through HELM's tagged dev/test/release workflow, not by deploying a development branch.
4. Invoke CC update solely for the affected plugin; it requests Refresh and fails closed on ambiguity.
5. In a new ChatGPT conversation, verify browser_open_session exposes the REQUIRED headless boolean and can open an explicitly selected mode. Only then claim the issue resolved.

## Verification
TypeScript compile succeeded. Vitest suite: 224 passed, 17 skipped, zero failed.
The top-level npm test launcher is separately blocked by a PRE-EXISTING mismatch between the pinned host-kit hash and the unchanged scripts/check-hidden-launch.mjs. Do not override that security gate without separate review.
