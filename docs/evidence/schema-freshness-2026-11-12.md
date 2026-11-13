# MCP tool-schema freshness evidence — 2026-11-12

User directive (verbatim): "It's unacceptable for us to have outdated connectors on any platform so that requires mediate solution"

Scope: Connector Connector issue #88. Development branch fix/schema-freshness-issue88 on W540. No production Connector Connector code was deployed during this exercise; native Refresh tools actions on the existing ChatGPT app installations WERE performed as directed, non-destructively.

## Verification method

The running connector's source catalog was retrieved through the configured MCP URL and its already-authorized secret resolver, with no secret values printed. The ChatGPT installed catalog was independently captured from the authenticated app UI's own successful GET /backend-api/aip/connectors/{installation_id} response, under the named main account. Source-vs-platform comparison covers every tool name, input property definitions and required-property lists. It DOES NOT establish equivalence of provider descriptions or output schema; these remain separate outstanding requirements under REQ-D011. The original plugin installation identity and exact account were checked. Native Refresh was used only when stale; afterward source and stored platform schemas were fetched again and compared. Tests and release gates are separately recorded.

## Production ChatGPT/main account — 11 of 12 configured connectors verified (input contracts)

| Connector | Result |
| --- | --- |
| vault-mcp | Refreshed in place; 7 tools matched 7, all input definitions/required matched |
| patchright-mcp | Refreshed in place; independent post-readback matched |
| helm-shell | Already current; unchanged |
| helm-relay | Already current; unchanged |
| helm-drive | Refreshed in place; independent post-readback matched |
| helm-audio-mcp | Refreshed in place; independent post-readback matched |
| helm-vision-mcp | Refreshed in place; independent post-readback matched |
| roku-mcp | Already current; unchanged |
| connector-connector | Refreshed in place; independent post-readback matched |
| helm-thread-monitor | Already current; unchanged, distinct TEST plugin untouched |
| fleet-connect | Refreshed in place; independent post-readback matched |
| dsm-connect | UNKNOWN: OAuth token unavailable to CC source reader; unauthenticated MCP initialize got HTTP 401 (auth challenge); installation unchanged |

The Thread Monitor prefix-card collision and Fleet Connect premature connected-status read produced initial false errors. Fixed exact card title selection (innerText first line, not prefix) and wait for hydrated connected state. Re-running both verified their actual status. This proves the selector defect was repaired, not that source or platform permissions changed.

The ChatGPT connector metadata is current for these eleven input contracts. A conversation that loaded tools before the native refresh can still contain old frozen signatures until the interface reloads them. No 12/12 all-current claim is made.

## Remaining platform and automation gaps (still open)

- Claude: installed connector list was reachable for the main account, but there is no verified source-vs-platform action-catalog reader or non-destructive native refresh wired into CC. Three independently configured Claude accounts require account-scoped checks. Production Claude update currently removes and recreates connectors: not suitable for automatic freshness repair.
- Grok: main account was ACCOUNT_MISMATCH on read-only CC list; no write was attempted. CC Grok update remains not implemented, and no authenticated action-catalog reader exists.
- DSM Connect (OAuth): source metadata reader has no authorized reusable OAuth client grant. The unauthenticated protocol probe yielded HTTP 401; no credential bypass was attempted.
- REQ-D013: automatic post-deployment triggers, scheduled sweeps, unresolved-state persistence and notification have not been implemented or deployed. This is a permanent open gate, not a promise of monitoring.
- REQ-D011: descriptions and output schema are not yet normalized/read back across platforms. The established verified claim is about tool names and INPUT schemas only.
- The new source code is isolated development, not production. It must pass all applicable HELM release approvals/tests before production promotion.

## Primary persisted host evidence (job IDs)

- Initial actual Vault source tools/list: job_mwe6ry218764c101
- Vault initial ChatGPT stale metadata: job_mwe6v2od74f66a3d
- Vault native refreshed 7/7: job_mwe6ybk0921fedb9
- Live source+platform input fingerprint match: job_mwe73ddf681fb283
- New CC input-schema update path already-current live test: job_mwe75tmd10cb7888
- Patchright/HELM Shell: job_mwe7727058d77370
- HELM Relay/HELM Drive: job_mwe788kocbafb5ba
- Audio/Vision: job_mwe79ar34e78efc0
- Roku/Connector Connector: job_mwe7at7jbf8bd768
- Initial Monitor/Fleet selector faults: job_mwe7btwd61295cad
- Fixed Monitor/Fleet readback: job_mwe7gr2od7e9c7a9
- DSM CC UNKNOWN: job_mwe7idckff045342; anonymous source auth refusal: job_mwe7jjyob2e53618

This record reports observed actions and remaining gaps; it is not a signoff or approval.