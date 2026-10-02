import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlatformAdapter } from "../src/adapters/types.js";
import type { BrowserSession } from "../src/browser/chrome.js";
import { loadRegistry } from "../src/core/registry.js";
import { run } from "../src/core/runner.js";
import { PLATFORMS, type Platform } from "../src/core/types.js";
import { registryFixture } from "./fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reg = loadRegistry(path.resolve("registry", "connectors.json"));
const { deps, secrets } = registryFixture(reg);
const ids = reg.connectors.filter((c) => c.tier !== "test" && PLATFORMS.every((p) => c.platforms.includes(p))).slice(0, 2).map((c) => c.id);

/** Fake platforms: every call takes `ms`, and the harness records when each platform's work started and ended. */
function harness(ms: number, opts: { failPlatform?: Platform; failOpen?: Platform } = {}) {
  const spans: { platform: Platform; connector: string; start: number; end: number }[] = [];
  const opened: Platform[] = [];
  const closed: Platform[] = [];
  const touchedBy: Record<string, string[]> = {};
  let live = 0, peak = 0;
  const sessionFactory = async (platform: Platform): Promise<BrowserSession> => {
    opened.push(platform);
    if (opts.failOpen === platform) throw new Error(`all cc browser lanes are busy (simulated for ${platform})`);
    const touched = new Set<string>();
    return { touched, close: async () => { closed.push(platform); touchedBy[platform] = [...touched]; } } as unknown as BrowserSession;
  };
  const adapter = (platform: Platform): PlatformAdapter => {
    const act = async (ctx: Parameters<PlatformAdapter["probe"]>[0], connector = "*") => {
      await ctx.session();
      const start = Date.now(); live++; peak = Math.max(peak, live);
      await sleep(ms);
      live--; spans.push({ platform, connector, start, end: Date.now() });
      if (opts.failPlatform === platform) throw new Error(`${platform} adapter exploded`);
      return { status: "ok" as const, detail: `${platform} done` };
    };
    return { platform, probe: (c) => act(c), list: async (c) => { await act(c); return { names: [] }; }, add: (c, rc) => act(c, rc.def.id), remove: (c, rc) => act(c, rc.def.id), update: (c, rc) => act(c, rc.def.id), verify: (c, rc) => act(c, rc.def.id) };
  };
  const adapters = Object.fromEntries(PLATFORMS.map((p) => [p, adapter(p)])) as Record<Platform, PlatformAdapter>;
  return { spans, opened, closed, touchedBy, adapters, sessionFactory, peak: () => peak };
}

describe("one call, one browser per platform; platforms at the same time when asked", () => {
  it("the three platforms overlap (wall time ~ the slowest, not the sum), each in its own session that touched only its platform", async () => {
    const h = harness(400);
    const t0 = Date.now();
    const res = await run(reg, { op: "verify", connectors: ids, platforms: [...PLATFORMS] }, { deps, adapters: h.adapters, sessionFactory: h.sessionFactory, platformParallelism: 3 });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    expect(res.items).toHaveLength(ids.length * PLATFORMS.length);
    expect(h.peak()).toBe(3);                              // three platforms were active together
    expect(elapsed).toBeLessThan(400 * ids.length * PLATFORMS.length * 0.6); // far below the sequential 2400 ms
    expect([...h.opened].sort()).toEqual([...PLATFORMS].sort()); // exactly one session per platform
    expect([...h.closed].sort()).toEqual([...PLATFORMS].sort()); // and all closed
    for (const p of PLATFORMS) expect(h.touchedBy[p]).toEqual([p]); // a platform's browser touched only that platform
    expect(JSON.stringify(res)).not.toMatch(new RegExp(secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
  });

  it("connectors on the same platform stay sequential, and results keep connector-major, platform-minor order", async () => {
    const h = harness(150);
    const res = await run(reg, { op: "verify", connectors: ids, platforms: [...PLATFORMS] }, { deps, adapters: h.adapters, sessionFactory: h.sessionFactory, platformParallelism: 3 });
    const order = res.items.map((i) => `${i.connector}@${i.platform}`);
    expect(order).toEqual(ids.flatMap((id) => PLATFORMS.map((p) => `${id}@${p}`)));
    for (const p of PLATFORMS) {
      const mine = h.spans.filter((s) => s.platform === p).sort((a, b) => a.start - b.start);
      for (let i = 1; i < mine.length; i++) expect(mine[i].start).toBeGreaterThanOrEqual(mine[i - 1].end - 5); // no overlap within one platform
    }
  });

  it("by default platforms run one after another (parallel was measured slower on the host); CC_PLATFORM_PARALLELISM opts in", async () => {
    delete process.env.CC_PLATFORM_PARALLELISM;
    const h = harness(100);
    await run(reg, { op: "verify", connectors: ids.slice(0, 1), platforms: [...PLATFORMS] }, { deps, adapters: h.adapters, sessionFactory: h.sessionFactory });
    expect(h.peak()).toBe(1);
    process.env.CC_PLATFORM_PARALLELISM = "3";
    try {
      const h2 = harness(100);
      await run(reg, { op: "verify", connectors: ids.slice(0, 1), platforms: [...PLATFORMS] }, { deps, adapters: h2.adapters, sessionFactory: h2.sessionFactory });
      expect(h2.peak()).toBe(3);
    } finally { delete process.env.CC_PLATFORM_PARALLELISM; }
  });

  it("platformParallelism caps how many platforms run together", async () => {
    const h = harness(200);
    await run(reg, { op: "verify", connectors: ids.slice(0, 1), platforms: [...PLATFORMS] }, { deps, adapters: h.adapters, sessionFactory: h.sessionFactory, platformParallelism: 1 });
    expect(h.peak()).toBe(1);
    const h2 = harness(200);
    await run(reg, { op: "verify", connectors: ids.slice(0, 1), platforms: [...PLATFORMS] }, { deps, adapters: h2.adapters, sessionFactory: h2.sessionFactory, platformParallelism: 2 });
    expect(h2.peak()).toBe(2);
  });

  it("a platform that fails (adapter error, or no browser available) does not disturb the others, and every opened session is still closed", async () => {
    const h = harness(100, { failPlatform: "grok", failOpen: "chatgpt" });
    const res = await run(reg, { op: "verify", connectors: ids.slice(0, 1), platforms: [...PLATFORMS] }, { deps, adapters: h.adapters, sessionFactory: h.sessionFactory });
    const by = Object.fromEntries(res.items.map((i) => [i.platform, i]));
    expect(by.claude.status).toBe("ok");
    expect(by.chatgpt.status).toBe("error");
    expect(by.chatgpt.detail).toMatch(/lanes are busy/);
    expect(by.grok.status).toBe("error");
    expect(by.grok.detail).toMatch(/grok adapter exploded/);
    expect(res.ok).toBe(false);
    expect(h.closed).toContain("claude"); expect(h.closed).toContain("grok");
  });

  it("a platform with nothing to do never opens a browser; dry runs open none", async () => {
    const h = harness(50);
    await run(reg, { op: "verify", connectors: ["vault-mcp"], platforms: ["claude"] }, { deps, adapters: h.adapters, sessionFactory: h.sessionFactory });
    expect(h.opened).toEqual(["claude"]);
    const h2 = harness(50);
    await run(reg, { op: "add", connectors: ids, platforms: [...PLATFORMS], dryRun: true }, { deps, adapters: h2.adapters, sessionFactory: h2.sessionFactory });
    expect(h2.opened).toEqual([]);
  });

  it("list and probe also run the platforms at the same time", async () => {
    const h = harness(300);
    const res = await run(reg, { op: "probe", connectors: [], platforms: [...PLATFORMS] }, { deps, adapters: h.adapters, sessionFactory: h.sessionFactory, platformParallelism: 3 });
    expect(res.items.map((i) => i.platform)).toEqual([...PLATFORMS]);
    expect(h.peak()).toBe(3);
  });
});
