import { defineConfig } from "vitest/config";

// ACCT-C11: the default account-registry source reads bw serve / vault-mcp; tests must never read the live vault.
export default defineConfig({
  test: {
    env: { BW_SERVE_URL: "http://127.0.0.1:9", VAULT_MCP_URL: "http://127.0.0.1:9" },
  },
});
