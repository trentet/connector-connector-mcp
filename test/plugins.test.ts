import { describe, expect, it } from "vitest";
import { loadAccounts, validatePlugins, type AccountDef } from "../src/core/accounts.js";
import { missingGates, planPlugins, runPlugins, type InstalledPlugin, type PluginsPage, type PluginsSession } from "../src/core/plugins.js";
import { PLUGIN_CLICK_DENY, loadPluginsSpec } from "../src/adapters/claudePlugins.js";
import { main } from "../src/cli.js";

/**
 * `cc plugins apply|verify` (AGM-DEPLOY-001 in trentet/helm-agent-management: deterministic, code-driven deployment of the
 * HELM AMS gate plugins to a claude.ai account so every new thread is governed). Invented accounts and plugin names only.
 */
const ACC = (gates: string[]): { id: string; plugins: { marketplace: string; gates: string[] } } => ({ id: "fixture", plugins: { marketplace: "owner/repo", gates } });
const noSleep = async () => {};
const RB = { attempts: 2, delayMs: 1 };

/** An in-memory claude.ai Plugins page: a Yours list, added marketplaces, counting every click. */
function fakeClaude(init: { installed?: InstalledPlugin[]; markets?: string[] } = {}, opts: { blocked?: Error; noEnableEffect?: boolean; noAddEffect?: boolean } = {}) {
  const installed: InstalledPlugin[] = (init.installed ?? []).map((p) => ({ ...p }));
  const markets = [...(init.markets ?? [])];
  const calls = { addMarket: 0, addGate: 0, enableGate: 0, lists: 0, opened: 0, closed: 0 };
  const page: PluginsPage = {
    async listInstalled() { calls.lists++; if (opts.blocked) throw opts.blocked; return installed.map((p) => ({ ...p })); },
    async listMarketplaces() { return [...markets]; },
    async addMarketplace(repo) { calls.addMarket++; if (!markets.includes(repo)) markets.push(repo); },
    async addGate(name) { calls.addGate++; if (opts.noAddEffect) return; if (!installed.find((p) => p.name === name)) installed.push({ name, enabled: true }); },
    async enableGate(name) { calls.enableGate++; if (opts.noEnableEffect) return; const p = installed.find((x) => x.name === name); if (p) p.enabled = true; },
  };
  const open = async (): Promise<PluginsSession> => { calls.opened++; return { page, close: async () => { calls.closed++; }, blockedKind: (e) => (e === opts.blocked ? "human-check" : undefined) }; };
  return { installed, markets, calls, open };
}

describe("registry: the plugins block is references only and the checked-in file is valid", () => {
  it("every plugins block is { marketplace, gates } and nothing else", () => {
    const a = loadAccounts();
    const withPlugins = a.accounts.filter((x) => x.plugins);
    expect(withPlugins.length).toBeGreaterThan(0); // the main account declares the gates
    for (const x of withPlugins) {
      expect(Object.keys(x.plugins!).sort()).toEqual(["gates", "marketplace"]);
      expect(x.plugins!.marketplace).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(x.plugins!.gates.length).toBeGreaterThan(0);
    }
  });
  it("validatePlugins refuses a bad marketplace, bad/duplicate gate names, empty gates and unknown fields", () => {
    expect(validatePlugins(undefined).join()).toMatch(/marketplace.*gates/);
    expect(validatePlugins({ marketplace: "noslash", gates: ["a"] }).join()).toMatch(/owner\/repo/);
    expect(validatePlugins({ marketplace: "o/r", gates: [] }).join()).toMatch(/at least one plugin/);
    expect(validatePlugins({ marketplace: "o/r", gates: ["Bad Name"] }).join()).toMatch(/lowercase/);
    expect(validatePlugins({ marketplace: "o/r", gates: ["a", "a"] }).join()).toMatch(/duplicate/);
    expect(validatePlugins({ marketplace: "o/r", gates: ["a"], extra: 1 }).join()).toMatch(/unknown field/);
    expect(validatePlugins({ marketplace: "owner/repo", gates: ["helm-reload-gate", "helm-permission-gate"] })).toEqual([]);
  });
});

describe("planPlugins / missingGates (pure)", () => {
  it("adds absent gates, enables disabled ones, leaves enabled ones", () => {
    const installed: InstalledPlugin[] = [{ name: "on", enabled: true }, { name: "off", enabled: false }];
    const plan = planPlugins(installed, ["on", "off", "absent"]);
    expect(plan.already).toEqual(["on"]);
    expect(plan.toEnable).toEqual(["off"]);
    expect(plan.toAdd).toEqual(["absent"]);
    expect(plan.marketplaceNeeded).toBe(true);
  });
  it("needs no marketplace when every required gate is already present", () => {
    expect(planPlugins([{ name: "a", enabled: false }], ["a"]).marketplaceNeeded).toBe(false);
  });
  it("missingGates returns only required gates that are not enabled", () => {
    expect(missingGates([{ name: "a", enabled: true }, { name: "b", enabled: false }], ["a", "b", "c"])).toEqual(["b", "c"]);
  });
});

describe("runPlugins apply", () => {
  it("adds the marketplace and the absent gates, then confirms on read-back", async () => {
    const f = fakeClaude({ installed: [] });
    const res = await runPlugins("apply", ACC(["g1", "g2"]), { open: f.open, sleep: noSleep, readBack: RB });
    expect(res.ok).toBe(true);
    expect(f.calls.addMarket).toBe(1);
    expect(f.calls.addGate).toBe(2);
    expect(f.installed.map((p) => p.name).sort()).toEqual(["g1", "g2"]);
    expect(f.calls.closed).toBe(1); // browser always closed
  });
  it("enables a present-but-disabled gate without re-adding the marketplace", async () => {
    const f = fakeClaude({ installed: [{ name: "g1", enabled: false }], markets: ["owner/repo"] });
    const res = await runPlugins("apply", ACC(["g1"]), { open: f.open, sleep: noSleep, readBack: RB });
    expect(res.ok).toBe(true);
    expect(f.calls.addMarket).toBe(0);
    expect(f.calls.enableGate).toBe(1);
    expect(f.installed[0].enabled).toBe(true);
  });
  it("is idempotent: all gates already enabled -> nothing is clicked", async () => {
    const f = fakeClaude({ installed: [{ name: "g1", enabled: true }, { name: "g2", enabled: true }], markets: ["owner/repo"] });
    const res = await runPlugins("apply", ACC(["g1", "g2"]), { open: f.open, sleep: noSleep, readBack: RB });
    expect(res.ok).toBe(true);
    expect(f.calls.addMarket + f.calls.addGate + f.calls.enableGate).toBe(0);
    expect(res.items.every((i) => i.action === "already-enabled")).toBe(true);
  });
  it("fails (ok=false) when a gate never shows as enabled on read-back, and never reports a false success", async () => {
    const f = fakeClaude({ installed: [] }, { noAddEffect: true }); // clicks do nothing
    const res = await runPlugins("apply", ACC(["g1"]), { open: f.open, sleep: noSleep, readBack: RB });
    expect(res.ok).toBe(false);
    expect(res.items.find((i) => i.gate === "g1")!.status).toBe("error");
  });
  it("stops and does not crash when the page is blocked (human check)", async () => {
    const blocked = new Error("challenge");
    const f = fakeClaude({}, { blocked });
    const res = await runPlugins("apply", ACC(["g1"]), { open: f.open, sleep: noSleep, readBack: RB });
    expect(res.ok).toBe(false);
    expect(res.notes.join()).toMatch(/human-check/);
    expect(f.calls.closed).toBe(1);
  });
  it("dry run opens no browser and reports what it would do", async () => {
    const f = fakeClaude({ installed: [] });
    const res = await runPlugins("apply", ACC(["g1", "g2"]), { dryRun: true, open: f.open });
    expect(res.ok).toBe(true);
    expect(f.calls.opened).toBe(0);
    expect(res.items.every((i) => i.status === "dry-run")).toBe(true);
  });
});

describe("runPlugins verify (read-only)", () => {
  it("passes when every gate is enabled and never clicks anything", async () => {
    const f = fakeClaude({ installed: [{ name: "g1", enabled: true }] });
    const res = await runPlugins("verify", ACC(["g1"]), { open: f.open });
    expect(res.ok).toBe(true);
    expect(f.calls.addMarket + f.calls.addGate + f.calls.enableGate).toBe(0);
  });
  it("fails and names a missing and a disabled gate", async () => {
    const f = fakeClaude({ installed: [{ name: "g2", enabled: false }] });
    const res = await runPlugins("verify", ACC(["g1", "g2"]), { open: f.open });
    expect(res.ok).toBe(false);
    expect(res.items.find((i) => i.gate === "g1")!.action).toBe("missing");
    expect(res.items.find((i) => i.gate === "g2")!.action).toBe("disabled");
  });
});

describe("bounds: PLUGIN_CLICK_DENY (enforced in code, not the data file)", () => {
  it("denies every destructive or out-of-scope control", () => {
    for (const n of ["Delete", "Remove plugin", "Uninstall", "Disable", "Turn off", "Rename", "Connectors", "Memory", "Billing", "Upgrade plan", "Sign in", "Continue with Google", "Disconnect"]) {
      expect(PLUGIN_CLICK_DENY.test(n)).toBe(true);
    }
  });
  it("allows the add/enable controls and a plugin's own name (incl. helm-permission-gate, which contains 'permission')", () => {
    for (const n of ["Add plugin", "Add marketplace", "Add", "Install", "Enable", "helm-reload-gate", "helm-permission-gate"]) {
      expect(PLUGIN_CLICK_DENY.test(n)).toBe(false);
    }
  });
});

describe("selectors spec", () => {
  it("loads and every page-fact is still unverified (must be grounded live before a real run)", () => {
    const spec = loadPluginsSpec();
    expect(spec.hosts).toContain("claude.ai");
    // nothing is marked verified yet, so the selector keys all appear as unverified
    expect(spec.unverified).toContain("pluginsUrl");
    expect(spec.unverified).toContain("enableToggle");
  });
});

describe("CLI", () => {
  it("dry-run verify on a declared account returns 0 and opens no browser", async () => {
    expect(await main(["plugins", "verify", "--account", "main", "--dry-run", "--json"])).toBe(0);
  });
  it("a bad subcommand is a usage error (2)", async () => {
    expect(await main(["plugins", "frobnicate", "--account", "main"])).toBe(2);
  });
  it("a missing --account is a usage error (2)", async () => {
    expect(await main(["plugins", "verify"])).toBe(2);
  });
  it("an unknown account is an error (not a silent fallback)", async () => {
    expect(await main(["plugins", "verify", "--account", "does-not-exist", "--dry-run"])).not.toBe(0);
  });
});
