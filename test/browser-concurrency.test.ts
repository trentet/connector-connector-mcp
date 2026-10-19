import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchChrome, openSession as realOpen, shutdownChrome, type BrowserSession } from "../src/browser/chrome.js";
import { acquireLane, portInUse } from "../src/browser/lanes.js";
import { loadRegistry } from "../src/core/registry.js";
import { run } from "../src/core/runner.js";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { registryFixture } from "./fixtures.js";
import { chromium } from "patchright";

const CHROME = process.env.CC_TEST_CHROME ?? (fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-")).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p)) : undefined);
const HEADLESS = "--headless=new --no-sandbox --disable-gpu";
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let site: http.Server;
let origin = "";
let host = "127.0.0.1";
let master = "";
let selectors = "";
let lanesDir = "";

/** A throwaway "platform": serves a blank page so tests can set per-browser state on a real origin. */
beforeAll(async () => {
  site = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>platform</title><body>ok</body>"); });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => site.close(r)); });

// Every session a test opens is closed afterwards even when an assertion throws, so a failure never leaves a Chrome behind.
const opened: BrowserSession[] = [];
const openSession = async () => { const s = await realOpen(); opened.push(s); return s; };
const envKeys = ["CC_CHROME_PATH", "CC_BROWSER_MASTER", "CC_CHROME_EXTRA_ARGS", "CC_LANES_DIR", "CC_MAX_CONCURRENCY", "CC_LANE_PORT_BASE", "CC_SELECTORS_DIR", "CC_LANE_WAIT_MS", "CC_ADMIT"];
afterEach(async () => { while (opened.length) await opened.pop()!.close().catch(() => {}); for (const k of envKeys) delete process.env[k]; });

/** Fresh master profile holding one persistent sign-in cookie ("authcookie"), a selectors dir declaring it as platform "testplat"'s proof of sign-in, and a private lane dir/port range. */
async function setup(portBase: number, max = 3) {
  master = tmp("cc-master-");
  selectors = tmp("cc-sel-");
  lanesDir = tmp("cc-lanes-");
  fs.writeFileSync(path.join(selectors, "testplat.json"), JSON.stringify({ auth: { cookie: "authcookie", refresh: ["authcookie"], hosts: [host], ssoHosts: [] } }));
  fs.writeFileSync(path.join(selectors, "testplat2.json"), JSON.stringify({ auth: { cookie: "authcookie2", refresh: ["authcookie2"], hosts: ["localhost"], ssoHosts: [] } }));
  Object.assign(process.env, { CC_CHROME_PATH: CHROME, CC_BROWSER_MASTER: master, CC_CHROME_EXTRA_ARGS: HEADLESS, CC_LANES_DIR: lanesDir, CC_MAX_CONCURRENCY: String(max), CC_LANE_PORT_BASE: String(portBase), CC_SELECTORS_DIR: selectors, CC_ADMIT: "off" /* these tests are about isolation, not politeness (see politeness.test.ts) */ });
  const seedPort = portBase + 50;
  const l = await launchChrome(master, seedPort);
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${seedPort}`);
  await b.contexts()[0].addCookies([{ name: "authcookie", value: "master-v0", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
  await shutdownChrome(b, l.child, l.exited);
}
const cookieValue = async (s: Awaited<ReturnType<typeof openSession>>, name: string) => (await s.context.cookies(origin)).find((c) => c.name === name)?.value;
const setCookie = (s: Awaited<ReturnType<typeof openSession>>, name: string, value: string) => s.context.addCookies([{ name, value, url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);

describe.skipIf(!CHROME)("one Chrome process per run (real Chromium)", () => {
  it("concurrent sessions get distinct lanes, ports, processes and profiles, each cloned from the master's sign-in", async () => {
    await setup(9460);
    const sessions = await Promise.all([openSession(), openSession(), openSession()]);
    const lanePorts = [9460, 9461, 9462];
    const ws = new Set<string>();
    for (const p of lanePorts) ws.add(((await (await fetch(`http://127.0.0.1:${p}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    expect(ws.size).toBe(3); // three independent browsers
    expect(fs.readdirSync(lanesDir).filter((f) => f.endsWith(".lock")).length).toBe(3);
    for (const s of sessions) { await s.page.goto(origin); expect(await cookieValue(s, "authcookie")).toBe("master-v0"); }
    await Promise.all(sessions.map((s) => s.close()));
    for (const p of lanePorts) expect(await portInUse(p)).toBe(false); // every process is gone
    expect(fs.readdirSync(lanesDir).filter((f) => f.endsWith(".lock"))).toEqual([]); // every lane released
  }, 120000);

  it("state set in one run is invisible to another, and one run closing does not disturb the other", async () => {
    await setup(9470, 2);
    const [a, b] = await Promise.all([openSession(), openSession()]);
    await Promise.all([a.page.goto(origin), b.page.goto(origin)]);
    await a.page.evaluate(() => localStorage.setItem("who", "A"));
    await setCookie(a, "only-in-a", "1");
    expect(await b.page.evaluate(() => localStorage.getItem("who"))).toBeNull();
    expect(await cookieValue(b, "only-in-a")).toBeUndefined();
    await a.close();
    // B keeps working after A's whole browser is gone: no "Target page, context or browser has been closed"
    await b.page.goto(origin + "/after-a-closed");
    expect(await b.page.title()).toBe("platform");
    await b.page.evaluate(() => localStorage.setItem("who", "B"));
    expect(await b.page.evaluate(() => localStorage.getItem("who"))).toBe("B");
    await b.close();
  }, 120000);

  it("a caller that finds every lane busy waits, then gets a clear error; a freed lane is reusable", async () => {
    await setup(9480, 1);
    const held = await acquireLane({ waitMs: 1000 });
    await expect(acquireLane({ waitMs: 1200 })).rejects.toThrow(/all 1 cc browser lanes are busy/);
    const waiter = acquireLane({ waitMs: 10000 });
    await sleep(700);
    held.release();
    const got = await waiter;
    expect(got.index).toBe(0);
    got.release();
  }, 60000);

  it("only rotated sign-in cookies of a healthy run are merged into the master; an older copy never overwrites a newer value; a signed-out run writes nothing", async () => {
    await setup(9490, 3);
    const [a, b] = await Promise.all([openSession(), openSession()]);
    a.touched!.add("testplat"); b.touched!.add("testplat");
    await a.page.goto(origin); await b.page.goto(origin);
    await setCookie(a, "authcookie", "rotated-by-A");     // A rotated the sign-in cookie
    await setCookie(a, "tracking", "noise");             // not a sign-in cookie: never merged
    await a.close();                                     // A merges into the master
    await b.close();                                     // B cloned BEFORE A merged and changed nothing: must not overwrite A's value
    const c = await openSession();
    await c.page.goto(origin);
    expect(await cookieValue(c, "authcookie")).toBe("rotated-by-A");
    expect(await cookieValue(c, "tracking")).toBeUndefined();
    // signed out: the platform cookie is gone, so nothing this run did reaches the master
    c.touched!.add("testplat");
    await c.context.clearCookies({ name: "authcookie" });
    await setCookie(c, "authcookie", "x"); await c.context.clearCookies({ name: "authcookie" });
    await c.close();
    const d = await openSession();
    await d.page.goto(origin);
    expect(await cookieValue(d, "authcookie")).toBe("rotated-by-A");
    await d.close();
  }, 180000);

  it("sibling runs that touched different platforms both merge their own rotation (the parallel-platform case)", async () => {
    await setup(9530, 3);
    const originLocalhost = origin.replace("127.0.0.1", "localhost");
    // master also needs a platform-2 cookie so the clone starts signed in to both
    const l = await launchChrome(master, 9580);
    const mb = await chromium.connectOverCDP("http://127.0.0.1:9580");
    await mb.contexts()[0].addCookies([{ name: "authcookie2", value: "master2-v0", url: originLocalhost, expires: Math.floor(Date.now() / 1000) + 86400 }]);
    await shutdownChrome(mb, l.child, l.exited);
    const [a, b] = await Promise.all([openSession(), openSession()]);
    a.touched!.add("testplat"); b.touched!.add("testplat2");
    await a.page.goto(origin); await b.page.goto(originLocalhost);
    await a.context.addCookies([{ name: "authcookie", value: "A-rotated", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
    await b.context.addCookies([{ name: "authcookie2", value: "B-rotated", url: originLocalhost, expires: Math.floor(Date.now() / 1000) + 86400 }]);
    await Promise.all([a.close(), b.close()]);
    const c = await openSession();
    await c.page.goto(origin);
    expect(await cookieValue(c, "authcookie")).toBe("A-rotated");
    expect((await c.context.cookies(originLocalhost)).find((k) => k.name === "authcookie2")?.value).toBe("B-rotated");
    await c.close();
    expect(fs.readdirSync(lanesDir).filter((f) => f.endsWith(".lock"))).toEqual([]);
  }, 180000);

  it("ONE run over three platforms drives three simultaneous real browsers, each isolated, and finishes in about the time of the slowest", async () => {
    await setup(9550, 4);
    const reg = loadRegistry(path.resolve("registry", "selftest.json"));
    const { deps } = registryFixture(reg);
    const plats = ["claude", "chatgpt", "grok"] as const;
    const lockCounts: number[] = []; const states: Record<string, { before: string | null; after: string | null }> = {};
    const adapters = Object.fromEntries(plats.map((platform) => {
      const act = async (ctx: Parameters<PlatformAdapter["probe"]>[0]) => {
        const s = await ctx.session();
        await s.page.goto(origin + `/${platform}`);
        const before = await s.page.evaluate(() => localStorage.getItem("who"));
        await s.page.evaluate((p) => localStorage.setItem("who", p), platform);
        await sleep(2500);
        lockCounts.push(fs.readdirSync(lanesDir).filter((f) => f.endsWith(".lock")).length); // browsers alive right now
        states[platform] = { before, after: await s.page.evaluate(() => localStorage.getItem("who")) };
        return { status: "ok" as const, detail: `${platform} ok` };
      };
      return [platform, { platform, probe: act, list: async () => ({ names: [] }), add: act, remove: act, update: act, verify: act } as PlatformAdapter];
    })) as Record<(typeof plats)[number], PlatformAdapter>;
    const t0 = Date.now();
    const res = await run(reg, { op: "add", account: "main", connectors: ["cc-selftest"], platforms: [...plats] }, { deps, adapters, platformParallelism: 3 });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    expect(Math.max(...lockCounts)).toBe(3);                    // three browsers were alive together
    for (const p of plats) expect(states[p]).toEqual({ before: null, after: p }); // none saw another's state
    expect(elapsed).toBeLessThan(2500 * 3);                     // not three sequential 2.5 s waits
    expect(fs.readdirSync(lanesDir).filter((f) => f.endsWith(".lock"))).toEqual([]);
  }, 180000);

  it("refuses a master that a running Chrome has open (copying a live profile is unreliable)", async () => {
    await setup(9500, 1);
    const l = await launchChrome(master, 9510);
    try { await expect(openSession()).rejects.toThrow(/in use by a running Chrome|COLD master/); } finally { await shutdownChrome(undefined, l.child, l.exited); }
    expect(fs.readdirSync(lanesDir).filter((f) => f.endsWith(".lock"))).toEqual([]); // a refused run does not leak its lane
  }, 60000);

  it("two simultaneous cc runs (add and verify of registry/selftest.json's connector) complete without crossing", async () => {
    await setup(9520, 2);
    const reg = loadRegistry(path.resolve("registry", "selftest.json"));
    const { deps, secrets } = registryFixture(reg);
    const seen: Record<string, { port: number; before: string | null; after: string | null; title: string }> = {};
    // A stand-in platform adapter: drives a real, private browser against the throwaway site, holding state across a long overlap window.
    const adapterFor = (platform: "claude" | "chatgpt", verb: "add" | "verify"): PlatformAdapter => {
      const act = async (ctx: Parameters<PlatformAdapter["probe"]>[0]) => {
        const s = await ctx.session();
        await s.page.goto(origin + `/${platform}`);
        const before = await s.page.evaluate(() => localStorage.getItem("who"));
        await s.page.evaluate((p) => localStorage.setItem("who", p), platform);
        await sleep(2500); // the other run is active in its own browser right now
        await s.page.goto(origin + `/${platform}/again`);
        const after = await s.page.evaluate(() => localStorage.getItem("who"));
        const port = await (async () => { for (const p of [9520, 9521]) { try { const j = (await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()) as { url: string }[]; if (j.some((t) => t.url.includes(`/${platform}`))) return p; } catch { /* next */ } } return -1; })();
        seen[`${verb}@${platform}`] = { port, before, after, title: await s.page.title() };
        return { status: "ok" as const, detail: `${verb} ${platform} done` };
      };
      return { platform, probe: act, list: async () => ({ names: [] }), add: act, remove: act, update: act, verify: act };
    };
    const [r1, r2] = await Promise.all([
      run(reg, { op: "add", account: "main", connectors: ["cc-selftest"], platforms: ["claude"] }, { deps, adapters: { claude: adapterFor("claude", "add") } }),
      run(reg, { op: "verify", connectors: ["cc-selftest"], platforms: ["chatgpt"] }, { deps, adapters: { chatgpt: adapterFor("chatgpt", "verify") } }),
    ]);
    for (const r of [r1, r2]) { expect(r.ok).toBe(true); expect(JSON.stringify(r)).not.toMatch(/Target page, context or browser has been closed/); for (const x of secrets) expect(JSON.stringify(r)).not.toContain(x); }
    expect(seen["add@claude"].before).toBeNull();   // saw none of the other run's state at start...
    expect(seen["verify@chatgpt"].before).toBeNull();
    expect(seen["add@claude"].after).toBe("claude"); // ...and still only its own after the overlap
    expect(seen["verify@chatgpt"].after).toBe("chatgpt");
    expect(seen["add@claude"].port).not.toBe(seen["verify@chatgpt"].port); // different browsers
    expect(fs.readdirSync(lanesDir).filter((f) => f.endsWith(".lock"))).toEqual([]);
  }, 180000);
});
