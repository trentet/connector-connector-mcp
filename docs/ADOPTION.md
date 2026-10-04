# Adopting cc in a connector repo

Connector repos do not register themselves anywhere. Put this in the repo's README / CLAUDE.md:

> **Registering this connector on claude.ai / ChatGPT / Grok is done by `connector-connector-mcp` (cc), not by a script in this repo.**
> Do not add `register-connector` scripts here. Add or update this connector's entry in cc's `registry/connectors.json`
> (id, display name, URL, auth, secret *references*), then run `cc add <id> --platform all` followed by `cc verify <id> --platform all`.

## What a registry entry needs
id (kebab-case) · name (and `nameByPlatform` if a platform shows a different name) · url · `urlByPlatform` for header-less platforms
(ChatGPT and Grok cannot send a custom header: the server must accept a token in the URL, e.g. `?token=`) · auth mode · secret references · enabled platforms.

## Server requirement for ChatGPT and Grok
The server must answer an unauthenticated-header `POST /mcp` initialize with 200 when the token is in the URL query. A server that only accepts a header
(for example Vault MCP today) can only be registered on claude.ai.

## Finding leftovers
`node bin/cc.mjs audit --scan <repo-root>` lists files that look like per-repo registrars so they can be removed once cc is verified.

## OAuth connectors (`auth.mode: "oauth"`)
The platform opens the connector's authorization page in cc's automation Chrome and nobody is at the host. If that page is a login form,
name the vault credential it accepts in the entry: `"auth": {"mode": "oauth", "oauthLogin": {"vaultLabel": "<label>"}}`. While an `add`/`update`
for that connector runs, cc signs in to a page on the **connector's own origin** with that credential (resolved in-process from the vault, never
returned or logged). It only acts on a page with a password field, never clicks a consent/Approve button on its own, and never touches another
origin. A login form with no `oauthLogin` configured is reported in the item detail, not guessed at. `cc add --dry-run` shows whether the vault
label resolves.

## Connectors that hold a Google OAuth grant (`googleOAuth`)
A connector whose server uses a Google refresh token (it has `credentials.json` + `token.json`) does **not** carry a renewal script either. Put this in its README / CLAUDE.md:

> **Renewing this connector's Google OAuth token is done by `connector-connector-mcp` (`cc reauth`), not by a script in this repo.**
> Do not add reauth / renew-token scripts or browser automation for Google's consent screen here. Add a `googleOAuth` block to this connector's cc registry entry, then `cc reauth <id> --dry-run` and `cc reauth <id>`.

The entry must also carry `repo` (`owner/name` of the connector's GitHub repo): `cc audit --google` uses it to prove this repo is covered, and fails for any repo that uses Google OAuth without a block (a repo that is not deployed yet is listed under `googleOAuthExemptions` with kind `pending`).

The block names where `credentials.json` / `token.json` live on the connector's host (`secretsDir`), the scopes, the Google account's vault label, optionally an ssh `host` (when the server runs elsewhere), a `restart` command and a `health` URL (so cc can restart it and prove it came back). The server only has to re-read `token.json` when it starts. The fallback stays in the repo: its own `auth:url` / `auth:exchange` consent flow, for when cc cannot do it. `cc audit --scan <repo-root>` also flags Google-consent look-alikes.

