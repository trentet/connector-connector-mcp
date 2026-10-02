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
