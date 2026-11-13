# Schema freshness branch validation — 2026-11-12

Source branch: fix/schema-freshness-issue88, based on connector-connector-mcp main (2026-11-12). Includes conflict-resolved prior native ChatGPT refresh work from draft PR #85, and this issue's MCP source catalog, ChatGPT installed catalog, deterministic comparisons, account-safe update path and regression tests.

Final full release pipeline after source and line-ending repairs:
- npm test -- --reporter=dot --testTimeout=12000: exit code 0; 331 passed, 17 skipped, 0 failed, 348 total across 28 test files. The npm test pipeline includes pinned hidden-launch integrity check.
- Requirements gate: py -3.12 scripts/req_gate.py static: exit 0 (req_gate static: ok).
- TypeScript typecheck and build: passed during the same branch validation.
- Targeted ChatGPT readback, canonical source and account safety regression tests: 37 passed. The previously failing generic source-code universality test was repaired by removing a connector-specific comment; full suite now passes.

Pinned script integrity root cause and repair:
- Git origin/main blob: 15,541 bytes, zero CRLF, SHA-256 4a534d04c258c6957cc73903986f50ac35dab22718ba99db17d00b17830406cc, exactly equal to scripts/check-hidden-launch.sha256.
- Windows checkout before fix: 15,848 bytes, 307 CRLF pairs, SHA-256 31d6533011fb3e61e7a83f6664b30efd7e429f7f3cff2328c08ec7dc433683d1. The difference was line-ending conversion; no change to the source Git blob or pinned expected hash was required.
- Added scripts/check-hidden-launch.mjs text eol=lf to .gitattributes. With core.autocrlf=true, a fresh git restore produced 15,541 bytes, zero CRLF and the pinned original SHA-256. npm run check:hidden-launch returned "nothing refused". The pin itself was not changed.

Live ChatGPT results were captured earlier and are separately recorded in schema-freshness-2026-11-12.md. The remaining DSM OAuth, Claude, Grok and deployment/sweep gaps remain open as that record states. This validation certifies the tested development branch, NOT deployment or all-platform production completeness.

Host evidence: job_mwe7rbw69e5c9870 (Git vs checkout hash), job_mwe7t0hd7173a983 (enforced attributes and restore), job_mwe7ts0za80e6629 (final release test and requirement gate).