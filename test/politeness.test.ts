import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { capacityByHardware, hasHeadroom, headroomLimits, sampleCpuBusy } from "../src/browser/hostload.js";
import { acquireLane } from "../src/browser/lanes.js";
import { launchChrome, openSession as realOpen, shutdownChrome, type BrowserSession } from "../src/browser/chrome.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const CHROME = process.env.CC_TEST_CHROME ?? (fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-")).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p)) : undefined);
const keys = ["CC_LANES_DIR", "CC_MAX_CONCURRENCY", "CC_LANE_PORT_BASE", "CC_ADMIT", "CC_ADMIT_MAX_CPU", "CC_ADMIT_MIN_FREE_GB", "CC_ADMIT_WAIT_MS", "CC_ADMIT_SETTLE_MS", "CC_BROWSER_CORES", "CC_CHROME_PATH", "CC_BROWSER_MASTER", "CC_CHROME_EXTRA_ARGS", "CC_CACHE_DIR", "CC_CHROME_PRIORITY"];
afterEach(() => { for (const k of keys) delete process.env[k]; });

describe("host headroom", () => {
  it("sampleCpuBusy is a percentage and cheap", async () => {
    const t = Date.now(); const v = await sampleCpuBusy(200);
    expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); expect(Date.now() - t).toBeLessThan(1500);
  });
  it("headroom needs both CPU and memory to be available", async () => {
    const lim = { maxCpuPercent: 70, minFreeGB: 1.5 };
    expect((await hasHeadroom(lim, async () => 30, () => 8)).ok).toBe(true);
    expect((await hasHeadroom(lim, async () => 90, () => 8)).ok).toBe(false);
    expect((await hasHeadroom(lim, async () => 30, () => 0.5)).ok).toBe(false);
  });
  it("limits come from the environment", () => {
    expect(headroomLimits({ CC_ADMIT_MAX_CPU: "55", CC_ADMIT_MIN_FREE_GB: "3" } as never)).toEqual({ maxCpuPercent: 55, minFreeGB: 3 });
    expect(headroomLimits({} as never)).toEqual({ maxCpuPercent: 60, minFreeGB: 1.5 });
  });
});

describe("hardware capacity", () => {
  it("scales with the machine: a weak laptop carries 2 cc browsers, a big server many, never fewer than 1", () => {
    const lim = { maxCpuPercent: 60, minFreeGB: 1.5 };
    expect(capacityByHardware(lim, 8, {} as never)).toBe(2);
    expect(capacityByHardware(lim, 32, {} as never)).toBe(11);
    expect(capacityByHardware(lim, 2, {} as never)).toBe(1);
    expect(capacityByHardware({ maxCpuPercent: 0.0001, minFreeGB: 0 }, 8, {} as never)).toBe(1);
    expect(capacityByHardware(lim, 8, { CC_BROWSER_CORES: "0.8" } as never)).toBe(6);
  });
});

describe("lane admission gate", () => {
  const lanes = () => { process.env.CC_LANES_DIR = tmp("cc-lanes-"); process.env.CC_MAX_CONCURRENCY = "3"; process.env.CC_LANE_PORT_BASE = "9740"; process.env.CC_ADMIT_SETTLE_MS = "0"; };
  it("the first browser is never held back, even on a fully busy host", async () => {
    lanes(); process.env.CC_ADMIT_MAX_CPU = "0.0001"; // "always busy"
    const t = Date.now(); const a = await acquireLane({ waitMs: 5000 });
    expect(Date.now() - t).toBeLessThan(1000); a.release();
  });
  it("a second browser waits for headroom on a busy host, then goes ahead anyway after the wait limit (slow, never failed)", async () => {
    lanes(); process.env.CC_ADMIT_MAX_CPU = "0.0001"; process.env.CC_ADMIT_WAIT_MS = "2500";
    const a = await acquireLane({ waitMs: 10000 });
    const t = Date.now(); const b = await acquireLane({ waitMs: 10000 });
    const waited = Date.now() - t;
    expect(waited).toBeGreaterThanOrEqual(2000); expect(waited).toBeLessThan(6000);
    expect(b.index).not.toBe(a.index); a.release(); b.release();
  });
  it("it lets a second browser straight in when the first one finishes while it waits", async () => {
    lanes(); process.env.CC_ADMIT_MAX_CPU = "0.0001"; process.env.CC_ADMIT_WAIT_MS = "30000";
    const a = await acquireLane({ waitMs: 10000 });
    const t = Date.now(); const pb = acquireLane({ waitMs: 40000 });
    setTimeout(() => a.release(), 1500);
    const b = await pb; expect(Date.now() - t).toBeLessThan(8000); b.release();
  });
  it("a host with headroom admits overlapping browsers immediately", async () => {
    lanes(); process.env.CC_ADMIT_MAX_CPU = "101"; process.env.CC_ADMIT_MIN_FREE_GB = "0"; process.env.CC_BROWSER_CORES = "0.01";
    const a = await acquireLane({ waitMs: 5000 });
    const t = Date.now(); const b = await acquireLane({ waitMs: 5000 });
    expect(Date.now() - t).toBeLessThan(1500); a.release(); b.release();
  });
  it("a second browser waits for the newest one to settle before the host load is judged (no thundering herd)", async () => {
    lanes(); process.env.CC_ADMIT_MAX_CPU = "101"; process.env.CC_ADMIT_MIN_FREE_GB = "0"; process.env.CC_BROWSER_CORES = "0.01"; process.env.CC_ADMIT_SETTLE_MS = "2500";
    const a = await acquireLane({ waitMs: 10000 });
    const t = Date.now(); const b = await acquireLane({ waitMs: 10000 });
    const waited = Date.now() - t;
    expect(waited).toBeGreaterThanOrEqual(2000); expect(waited).toBeLessThan(6000);
    a.release(); b.release();
  });
  it("three browsers started at the same moment are staggered, not admitted as a herd, and capacity caps how many run together", async () => {
    lanes(); process.env.CC_ADMIT_MAX_CPU = "101"; process.env.CC_ADMIT_MIN_FREE_GB = "0"; process.env.CC_ADMIT_SETTLE_MS = "1500"; process.env.CC_BROWSER_CORES = String((os.cpus().length * 101) / 100 / 2); // capacity = 2
    const t0 = Date.now(); const starts: number[] = [];
    const run = async () => { const l = await acquireLane({ waitMs: 30000 }); starts.push(Date.now() - t0); await new Promise((r) => setTimeout(r, 4000)); l.release(); };
    await Promise.all([run(), run(), run()]);
    starts.sort((a, b) => a - b);
    expect(starts[0]).toBeLessThan(1000);                // the first starts at once
    expect(starts[1]).toBeGreaterThanOrEqual(1300);       // the second waits for the first to settle
    expect(starts[2]).toBeGreaterThanOrEqual(3500);       // the third waits for a slot (capacity 2) until the first finishes
  }, 60000);
  it("CC_ADMIT=off disables the gate", async () => {
    lanes(); process.env.CC_ADMIT_MAX_CPU = "0.0001"; process.env.CC_ADMIT = "off";
    const a = await acquireLane({ waitMs: 5000 }); const t = Date.now(); const b = await acquireLane({ waitMs: 5000 });
    expect(Date.now() - t).toBeLessThan(1000); a.release(); b.release();
  });
});

describe.skipIf(!CHROME)("browser politeness (real Chromium)", () => {
  const HEADLESS = "--headless=new --no-sandbox --disable-gpu";
  it("each lane keeps a warm HTTP cache across runs: the second run on a lane does not refetch a cacheable resource", async () => {
    let hits = 0;
    const site = http.createServer((req, res) => {
      if (req.url === "/asset.js") { hits++; res.setHeader("cache-control", "public, max-age=3600"); res.setHeader("content-type", "text/javascript"); res.end("window.__asset=1;"); return; }
      res.setHeader("content-type", "text/html"); res.end('<script src="/asset.js"></script><title>t</title>');
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const master = tmp("cc-master-"); const cache = tmp("cc-cache-");
    Object.assign(process.env, { CC_CHROME_PATH: CHROME, CC_BROWSER_MASTER: master, CC_CHROME_EXTRA_ARGS: HEADLESS, CC_LANES_DIR: tmp("cc-lanes-"), CC_MAX_CONCURRENCY: "1", CC_LANE_PORT_BASE: "9770", CC_CACHE_DIR: cache, CC_ADMIT: "off" });
    const seed = await launchChrome(master, 9790); await shutdownChrome(undefined, seed.child, seed.exited); // a cold master with a profile in it
    const open = async () => realOpen() as Promise<BrowserSession>;
    try {
      const a = await open(); await a.page.goto(origin); await a.close();
      expect(hits).toBe(1);
      expect(fs.readdirSync(path.join(cache, "lane-0")).length).toBeGreaterThan(0); // the lane's cache survived the run
      const b = await open(); await b.page.goto(origin); await b.close();
      expect(hits).toBe(1); // second run served from the lane's cache
    } finally { await new Promise((r) => site.close(r)); }
  }, 90000);
});
