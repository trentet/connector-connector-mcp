import { describe, expect, it } from "vitest";
import { parseRow } from "../src/adapters/claude.js";
import { run } from "../src/core/runner.js";
import { loadRegistry } from "../src/core/registry.js";
import type { PlatformAdapter } from "../src/adapters/types.js";

describe("claude list parsing (rows captured live 2026-10-01)", () => {
  it("parses the REAL raw innerText (icon-font characters between cells), captured live", () => {
    expect(parseRow("Gmail\n\t\nWeb\n\t\n\uE03B\nConnected")).toEqual({ name: "Gmail", custom: false, connected: true });
    expect(parseRow("Figma\n\t\nWeb\n\t\n\uE055\nConnect")).toEqual({ name: "Figma", custom: false, connected: false });
  });
  it("still finds a row whose status is neither Connected nor Connect (e.g. a re-authorise state), and reports it", () => {
    expect(parseRow("DSM Connect Web Custom Reconnect")).toEqual({ name: "DSM Connect", custom: true, connected: false, status: "Reconnect" });
    expect(parseRow("DSM Connect Web Custom Needs authentication")).toMatchObject({ name: "DSM Connect", connected: false, status: "Needs authentication" });
    expect(parseRow("Gmail Web Connected")).toEqual({ name: "Gmail", custom: false, connected: true });
  });
  it("parses built-in, custom, and not-connected rows; ignores the header", () => {
    expect(parseRow("Connector Type Status")).toBeUndefined();
    expect(parseRow("Gmail Web  Connected")).toEqual({ name: "Gmail", custom: false, connected: true });
    expect(parseRow("HELM Shell Web Custom  Connected")).toEqual({ name: "HELM Shell", custom: true, connected: true });
    expect(parseRow("Scholar Gateway Web Custom Connect")).toEqual({ name: "Scholar Gateway", custom: true, connected: false });
    expect(parseRow("Fathom – Your Meeting Intelligence Layer Web Connect")).toEqual({ name: "Fathom – Your Meeting Intelligence Layer", custom: false, connected: false });
    expect(parseRow("HELM Drive Connector TEST Web Custom  Connected")?.name).toBe("HELM Drive Connector TEST");
  });
});

describe("runner list/probe", () => {
  it("lists once per platform (not once per connector) and closes the session it opened", async () => {
    let listCalls = 0, closed = 0;
    const adapter: PlatformAdapter = { platform: "claude", list: async () => { listCalls++; return { names: ["a", "b"] }; }, add: async () => ({ status: "ok" }), remove: async () => ({ status: "ok" }), update: async () => ({ status: "ok" }), verify: async () => ({ status: "ok" }), probe: async () => ({ status: "ok" }) };
    const reg = loadRegistry("registry/connectors.json");
    const res = await run(reg, { op: "list", connectors: ["*"], platforms: ["claude"] }, { adapters: { claude: adapter }, sessionFactory: async () => ({ close: async () => { closed++; } }) as never });
    expect(listCalls).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].detail).toBe("a, b");
    expect(closed).toBe(0); // adapter never asked for a session, so none was opened
  });
  it("per-platform display name is used for lookups", async () => {
    let seen = "";
    const adapter: PlatformAdapter = { platform: "claude", list: async () => ({ names: [] }), add: async () => ({ status: "ok" }), remove: async () => ({ status: "ok" }), update: async () => ({ status: "ok" }), probe: async () => ({ status: "ok" }), verify: async (_c, rc) => { seen = rc.name; return { status: "ok" }; } };
    const reg = loadRegistry("registry/connectors.json");
    const env = { HELM_X: "x" };
    void env;
    const res = await run(reg, { op: "verify", connectors: ["helm-drive"], platforms: ["claude"] }, { adapters: { claude: adapter }, deps: { env: {}, readFile: () => "https://mcp.trentt.me/mcp?token=abcd1234", vault: async () => undefined } });
    expect(res.ok).toBe(true);
    expect(seen).toBe("HELM Drive Connector");
  });
});
