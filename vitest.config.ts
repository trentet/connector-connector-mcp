import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// ACCT-C11: the default account-registry source reads bw serve / vault-mcp; tests must never read the live vault.
export default defineConfig({
  test: {
    // CC_DATA_DIR: run locks and run logs of tests stay out of the host's real cc data dir (REQ-D008).
    env: { BW_SERVE_URL: "http://127.0.0.1:9", VAULT_MCP_URL: "http://127.0.0.1:9", CC_DATA_DIR: path.join(os.tmpdir(), "cc-vitest-data"),
      // REQ-D015: on Windows every acquireLane would run one window enumeration (a PowerShell process); the gate and lane tests measure their own timing, so the hold is off for them. test/screen-hold.test.ts switches it on again for itself.
      CC_SCREEN_HOLD: "off" },
  },
});
