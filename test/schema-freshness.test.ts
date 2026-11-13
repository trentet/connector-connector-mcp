import { collectToolPages } from "../src/core/liveToolCatalog.js";
import { describe, expect, it, vi } from "vitest";
import { compareToolCatalogs, type McpToolContract, type ToolCatalog } from "../src/core/toolSchema.js";
import { reconcileToolSchemas, type FreshnessServices } from "../src/core/schemaFreshness.js";

/** REQ-D011: actual tool-contract comparison, never Connected/Installed alone. */
const a: McpToolContract = {
  name: "vault_request_secret", description: "Store credential in a secure form",
  inputSchema: {
    type: "object", properties: {
      label: { type: "string" },
      username: { type: "string" },
      used_with: { type: "object" },
    }, required: ["label", "used_with"],
  },
};
const b: McpToolContract = { name: "vault_list_refs", inputSchema: { type: "object", properties: {} } };
const c = (tools: McpToolContract[], installationId = "existing-connector-identity", complete = true): ToolCatalog =>
  ({ tools, installationId, complete });

describe("REQ-D011 canonical tool-schema equivalence", () => {
  it("ignores tool order, property order and required-field order", () => {
    const same: McpToolContract = {
      name: a.name, description: a.description, inputSchema: {
        required: ["used_with", "label"], properties: {
          used_with: { type: "object" }, username: { type: "string" }, label: { type: "string" },
        }, type: "object",
      },
    };
    const r = compareToolCatalogs(c([a, b]), c([b, same]));
    expect(r.status).toBe("CURRENT");
    expect(r.sourceHash).toBe(r.installedHash);
  });

  it("detects a missing username field in the platform's outdated signature", () => {
    const old: McpToolContract = {
      name: a.name, description: a.description, inputSchema: {
        type: "object", properties: { label: { type: "string" } }, required: ["label"],
      },
    };
    const r = compareToolCatalogs(c([a]), c([old]));
    expect(r.status).toBe("STALE");
    expect(r.changed).toEqual([a.name]);
    expect(r.sourceHash).not.toBe(r.installedHash);
  });

  it("detects new, missing and renamed tools separately", () => {
    const r = compareToolCatalogs(c([a, b]), c([{ ...a, name: "old_name" }]));
    expect(r).toMatchObject({ status: "STALE", missing: [b.name, a.name], extra: ["old_name"], changed: [] });
  });

  it("detects changed required field even if properties are identical", () => {
    const old: McpToolContract = {
      ...a, inputSchema: { ...(a.inputSchema as object), required: ["label"] },
    };
    expect(compareToolCatalogs(c([a]), c([old])).changed).toEqual([a.name]);
  });

  it("detects a changed output schema and description", () => {
    const r = compareToolCatalogs(c([{ ...a, outputSchema: { type: "object" } }]),
      c([{ ...a, description: "outdated" }]));
    expect(r.status).toBe("STALE");
    expect(r.changed).toEqual([a.name]);
  });

  it("never marks an empty or incomplete catalog current", () => {
    expect(compareToolCatalogs(c([]), c([])).status).toBe("UNKNOWN");
    expect(compareToolCatalogs(c([a], "id", false), c([a])).status).toBe("UNKNOWN");
    expect(compareToolCatalogs(c([a]), c([a], "id", false)).status).toBe("UNKNOWN");
  });

  it("never marks duplicate or ambiguous tool names current", () => {
    expect(compareToolCatalogs(c([a, a]), c([a])).status).toBe("UNKNOWN");
    expect(compareToolCatalogs(c([{ name: " " }]), c([a])).status).toBe("UNKNOWN");
  });

  it("rejects invalid non-JSON schema rather than silently omitting it", () => {
    expect(compareToolCatalogs(c([{ name: "test", inputSchema: { fn: () => "bad" } }]), c([b])).status).toBe("UNKNOWN");
  });
});

const services = (overrides: Partial<FreshnessServices> = {}): FreshnessServices => ({
  expectedAccount: "verified@example.test",
  readAccount: vi.fn(async () => "verified@example.test"),
  readServerCatalog: vi.fn(async () => c([a, b])),
  readPlatformCatalog: vi.fn(async () => c([a, b])),
  ...overrides,
});

describe("REQ-D012 and REQ-D014 native refresh and account safety", () => {
  it("returns current without changing anything when contracts match", async () => {
    const refreshNative = vi.fn(async (id: string) => ({ acknowledged: true, mode: "native-in-place" as const, installationId: id }));
    const r = await reconcileToolSchemas(services({ refreshNative }));
    expect(r.status).toBe("CURRENT");
    expect(r.attemptedRefresh).toBe(false);
    expect(refreshNative).not.toHaveBeenCalled();
  });

  it("blocks all reads and writes if signed-in account is wrong", async () => {
    const readServerCatalog = vi.fn(async () => c([a]));
    const readPlatformCatalog = vi.fn(async () => c([a]));
    const refreshNative = vi.fn(async () => ({ acknowledged: true, mode: "native-in-place" as const, installationId: "x" }));
    const r = await reconcileToolSchemas(services({
      readAccount: async () => "somebody-else@example.test", readServerCatalog, readPlatformCatalog, refreshNative,
    }));
    expect(r.status).toBe("ACCOUNT_BLOCKED");
    expect(readServerCatalog).not.toHaveBeenCalled();
    expect(readPlatformCatalog).not.toHaveBeenCalled();
    expect(refreshNative).not.toHaveBeenCalled();
  });

  it("blocks an unreadable account or an implicit empty account", async () => {
    expect((await reconcileToolSchemas(services({ readAccount: async () => null }))).status).toBe("ACCOUNT_BLOCKED");
    expect((await reconcileToolSchemas(services({ expectedAccount: "" }))).status).toBe("ACCOUNT_BLOCKED");
  });

  it("treats failed source or platform reads as UNKNOWN, not current", async () => {
    const r = await reconcileToolSchemas(services({ readServerCatalog: async () => { throw new Error("secret token in URL"); } }));
    expect(r).toMatchObject({ status: "UNKNOWN", reason: "source-or-platform-read-failed" });
    expect(JSON.stringify(r)).not.toContain("secret token");
  });

  it("leaves a stale connector stale if platform-native refresh is not supported", async () => {
    const r = await reconcileToolSchemas(services({ readPlatformCatalog: async () => c([b]) }));
    expect(r).toMatchObject({ status: "STALE", attemptedRefresh: false, reason: "native-refresh-unavailable" });
  });

  it("refuses a refresh if the original installation identity is unknown", async () => {
    const refreshNative = vi.fn(async (id: string) => ({ acknowledged: true, mode: "native-in-place" as const, installationId: id }));
    const r = await reconcileToolSchemas(services({ readPlatformCatalog: async () => c([b], ""), refreshNative }));
    expect(r.status).toBe("STALE");
    expect(refreshNative).not.toHaveBeenCalled();
  });

  it("refreshes the same installation and independently reads both catalogs back", async () => {
    let installed = c([b]); let sourceReads = 0;
    const readServerCatalog = vi.fn(async () => { sourceReads++; return c([a, b]); });
    const refreshNative = vi.fn(async (id: string) => {
      installed = c([a, b], id);
      return { acknowledged: true, mode: "native-in-place" as const, installationId: id };
    });
    const r = await reconcileToolSchemas(services({ readServerCatalog,
      readPlatformCatalog: async () => installed, refreshNative }));
    expect(r).toMatchObject({ status: "CURRENT", attemptedRefresh: true, refreshed: true });
    expect(sourceReads).toBe(2);
    expect(refreshNative).toHaveBeenCalledWith("existing-connector-identity");
  });

  it("does not trust an HTTP 200 or an acknowledged refresh without matching tools", async () => {
    const r = await reconcileToolSchemas(services({
      readPlatformCatalog: async () => c([b]),
      refreshNative: async (id: string) => ({ acknowledged: true, mode: "native-in-place", installationId: id }),
    }));
    expect(r).toMatchObject({ status: "REFRESH_FAILED", reason: "post-refresh-catalog-not-current" });
  });

  it("refuses an accidental installation replacement instead of calling it a refresh", async () => {
    let calls = 0;
    const r = await reconcileToolSchemas(services({
      readPlatformCatalog: async () => (++calls === 1 ? c([b]) : c([a, b], "different-installation")),
      refreshNative: async (id) => ({ acknowledged: true, mode: "native-in-place", installationId: id }),
    }));
    expect(r).toMatchObject({ status: "REFRESH_FAILED", reason: "installation-identity-changed" });
  });

  it("fails closed on an unsupported or destructive refresh acknowledgement", async () => {
    const r = await reconcileToolSchemas(services({
      readPlatformCatalog: async () => c([b]),
      refreshNative: async () => ({ acknowledged: true, mode: "remove-add" as any, installationId: "existing-connector-identity" }),
    }));
    expect(r.status).toBe("REFRESH_FAILED");
  });

  it("refuses after a cross-account switch during refresh", async () => {
    let call = 0;
    const readAccount = vi.fn(async () => (++call === 1 ? "verified@example.test" : "wrong@example.test"));
    const r = await reconcileToolSchemas(services({
      readAccount,
      readPlatformCatalog: async () => c([b]),
      refreshNative: async (id) => ({ acknowledged: true, mode: "native-in-place", installationId: id }),
    }));
    expect(r.status).toBe("ACCOUNT_BLOCKED");
    expect(r.attemptedRefresh).toBe(true);
  });

  it("does not leak an exception message from a failing native refresh", async () => {
    const r = await reconcileToolSchemas(services({
      readPlatformCatalog: async () => c([b]),
      refreshNative: async () => { throw new Error("private API token leak"); },
    }));
    expect(r).toMatchObject({ status: "REFRESH_FAILED", reason: "native-refresh-threw" });
    expect(JSON.stringify(r)).not.toContain("private API token");
  });

  it("catches server schema changes during refresh instead of falsely reporting current", async () => {
    let reads = 0, installed = c([b]);
    const r = await reconcileToolSchemas(services({
      readServerCatalog: async () => (++reads === 1 ? c([a, b]) : c([a, b, { name: "new_tool" }])),
      readPlatformCatalog: async () => installed,
      refreshNative: async (id) => {
        installed = c([a, b], id);
        return { acknowledged: true, mode: "native-in-place", installationId: id };
      },
    }));
    expect(r).toMatchObject({ status: "REFRESH_FAILED", reason: "post-refresh-catalog-not-current" });
  });
});

describe("REQ-D011 full MCP tools/list pagination", () => {
  it("collects every page and treats a finished cursor as a complete catalog", async () => {
    const seen: Array<string | undefined> = [];
    const catalog = await collectToolPages(async (cursor) => {
      seen.push(cursor);
      return cursor === undefined ? { tools: [a], nextCursor: "next" } : { tools: [b] };
    });
    expect(catalog.complete).toBe(true);
    expect(catalog.tools.map((tool) => tool.name)).toEqual([a.name, b.name]);
    expect(seen).toEqual([undefined, "next"]);
  });

  it("refuses a repeating cursor or duplicate tool name across pages", async () => {
    await expect(collectToolPages(async () => ({ tools: [a], nextCursor: "same" })))
      .rejects.toThrow(/ambiguous MCP|cyclic MCP/);
    await expect(collectToolPages(async (cursor) =>
      cursor ? { tools: [a] } : { tools: [a], nextCursor: "next" }))
      .rejects.toThrow("ambiguous MCP tool definition");
  });

  it("refuses a pagination limit, an empty catalog, and malformed page", async () => {
    await expect(collectToolPages(async () => ({ tools: [a], nextCursor: "continue" }), { maxPages: 1 }))
      .rejects.toThrow("incomplete paginated MCP tools/list");
    await expect(collectToolPages(async () => ({ tools: [] }))).rejects.toThrow("empty MCP tools/list");
    await expect(collectToolPages(async () => ({ tools: null as any }))).rejects.toThrow("invalid MCP tools/list");
  });
});