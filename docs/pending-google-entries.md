# Google-OAuth registry blocks that are ready but must not be added yet

`cc audit --google` lists these as `PENDING`. A `googleOAuth` block makes the weekly `cc reauth --all` renew that connector, and a renewal for a
connector whose files do not exist yet is reported as a failure every week, so each block below is held until its prerequisites exist.

## helm-vision-mcp (repo `trentet/helm-vision-mcp`, host KNOTTYAI-PC)

Facts are from that repo's README ("Renewal by cc", 2026-10-04); nothing here is guessed. Add the entry when ALL of these are true (its docs/MIGRATION.md steps 2, 5, 6):
`credentials.json` and `token.json` exist in the secrets folder below, the Scheduled Tasks `helm-vision-mcp Server` / `helm-vision-mcp-test Server` are registered, and
`http://127.0.0.1:8797/health` answers on KNOTTYAI-PC. The connector's own registry entry (url, auth, platforms) comes from its registration, since its tunnel
(`vision.trentt.me`) is not provisioned yet; the `repo` field and this block are what the weekly renewal needs. Then delete the `pending` exemption for it in
`registry/connectors.json`, run `node bin\cc.mjs reauth helm-vision-mcp --dry-run`, and update the Coverage paragraph of `docs/weekly-reauth-routine.md`.

Production entry, add to the `helm-vision-mcp` connector:

```json
"repo": "trentet/helm-vision-mcp",
"googleOAuth": {
  "secretsDir": "C:\\Users\\KnottyAI\\AppData\\Local\\HELM\\helm-vision-mcp\\production\\secrets",
  "scopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets"
  ],
  "account": { "vaultLabel": "Google Account (trenterrolthomas@gmail.com)" },
  "host": { "ssh": "KnottyAI@192.168.23.200", "keyFile": "%USERPROFILE%\\.ssh\\knottyai-pc_helm-shell", "os": "windows" },
  "restart": { "command": "powershell -NoProfile -NonInteractive -Command Stop-ScheduledTask -TaskName 'helm-vision-mcp Server'; Start-Sleep -Seconds 3; Start-ScheduledTask -TaskName 'helm-vision-mcp Server'" },
  "health": { "url": "http://127.0.0.1:8797/health", "contains": "\"status\":\"ok\"", "waitSeconds": 90 }
}
```

Test entry (tier `test`, so it is renewed only on request): the same block with `secretsDir` `...\\helm-vision-mcp\\test\\secrets`, task name `'helm-vision-mcp-test Server'`
and health URL `http://127.0.0.1:8798/health`.

The ssh `keyFile` is the one helm-audio-mcp's entry already uses for the same host (KNOTTYAI-PC); check that it still opens a session before the first real run
(`cc reauth helm-vision-mcp --dry-run` does check SSH reachability).
