// REQ-D015 (REQ-U016): the screen hold. cc starts no browser while the screen is in use; a run that meets the hold waits for it to clear.
// Everything here is unit level: no Chrome, no window, no real session. The one real call (TC-D015-24) is a read-only window enumeration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLane } from "../src/browser/lanes.js";
import {
  clearManualHold, holdFilePath, loadHoldSpec, parseProbeOutput, probeOverlayWindows, screenHoldStatus, setManualHold, waitForScreenFree,
  type HoldDeps, type OverlayWindow,
} from "../src/browser/screenHold.js";
import { main } from "../src/cli.js";
import { holdCommand } from "../src/browser/screenHold.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spec = loadHoldSpec();
const CLASS = spec.overlayWindowClasses[0]!;
const ME = process.pid;
const aliveOnlyMe = (pid: number) => pid === ME;

let dir = "";
const saved: Record<string, string | undefined> = {};
const envKeys = ["CC_LANES_DIR", "CC_LANE_PORT_BASE", "CC_ADMIT", "CC_SCREEN_HOLD", "CC_SCREEN_HOLD_POLL_MS", "CC_SCREEN_HOLD_MAX_WAIT_MS", "CC_MAX_CONCURRENCY"];
beforeEach(() => {
  for (const k of envKeys) saved[k] = process.env[k];
  dir = tmp("cc-hold-");
  Object.assign(process.env, { CC_LANES_DIR: dir, CC_LANE_PORT_BASE: "39400", CC_ADMIT: "off", CC_MAX_CONCURRENCY: "2" });
  for (const k of ["CC_SCREEN_HOLD", "CC_SCREEN_HOLD_POLL_MS", "CC_SCREEN_HOLD_MAX_WAIT_MS"]) delete process.env[k];
});
afterEach(() => {
  for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A clock that only moves when a run sleeps, so a ten-minute wait takes no time. */
function fakeClock() {
  let t = 5_000_000;
  const start = t;
  const sleeps: number[] = [];
  return { start, now: () => t, elapsed: () => t - start, sleeps, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
}
const win = (pid = ME, cls = CLASS): OverlayWindow => ({ className: cls, pid });
const lines = () => { const out: string[] = []; return { out, log: (m: string) => { out.push(m); } }; };
const slots = () => fs.readdirSync(dir).filter((f) => /^slot-\d+\.lock$/.test(f));

describe("REQ-D015 the hold is checked where every browser start passes", () => {
  it("TC-D015-01 acquireLane waits while a hold is set, claims no lane meanwhile, and returns a lane once the hold is cleared", async () => {
    setManualHold(dir, { reason: "assignment on the screen" });
    process.env.CC_SCREEN_HOLD_POLL_MS = "500";
    const l = lines();
    const p = acquireLane({ hold: { probe: async () => [], log: l.log } });
    let done = false; void p.then(() => { done = true; });
    await sleepReal(900);
    expect(done).toBe(false);
    expect(slots()).toEqual([]);
    clearManualHold(dir);
    const lane = await p;
    expect(slots().length).toBe(1);
    lane.release();
    expect(l.out.some((m) => /waiting/.test(m))).toBe(true);
    expect(l.out.some((m) => /clear after waiting/.test(m))).toBe(true);
  });

  it("TC-D015-02 acquireLane with no hold set returns at once and says nothing", async () => {
    const l = lines();
    const t0 = Date.now();
    const lane = await acquireLane({ hold: { probe: async () => [], log: l.log } });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(l.out).toEqual([]);
    lane.release();
  });

  it("TC-D015-03 a lane claimed before the hold was set is not touched by a hold set later", async () => {
    const lane = await acquireLane({ hold: { probe: async () => [] } });
    setManualHold(dir, { reason: "later" });
    expect(slots().length).toBe(1);
    lane.release();
    expect(slots()).toEqual([]);
  });
});

describe("REQ-D015 the screen-control session as the source", () => {
  it("TC-D015-04 an overlay window of a live process holds the screen and the status names its class and process", async () => {
    const st = await screenHoldStatus(dir, { probe: async () => [win()], alive: aliveOnlyMe });
    expect(st.held).toBe(true);
    expect(st.reasons.join(" ")).toContain(CLASS);
    expect(st.reasons.join(" ")).toContain(String(ME));
  });

  it("TC-D015-05 the hold clears the moment the window is gone", async () => {
    let windows: OverlayWindow[] = [win()];
    const deps: HoldDeps = { probe: async () => windows, alive: aliveOnlyMe };
    expect((await screenHoldStatus(dir, deps)).held).toBe(true);
    windows = [];
    expect((await screenHoldStatus(dir, deps)).held).toBe(false);
  });

  it("TC-D015-06 the window classes come from data/screen-hold.json and the code holds no copy of them", async () => {
    expect(spec.overlayWindowClasses.length).toBeGreaterThan(0);
    expect(spec.label.length).toBeGreaterThan(0);
    let seen: string[] = [];
    await screenHoldStatus(dir, { probe: async (c) => { seen = c; return []; } });
    expect(seen).toEqual(spec.overlayWindowClasses);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk("src")) {
      const t = fs.readFileSync(f, "utf8");
      for (const c of spec.overlayWindowClasses) expect(t.includes(c), `${f} holds the class name ${c}`).toBe(false);
    }
  });

  it("TC-D015-07 a window whose owner process is gone does not hold the screen", async () => {
    const st = await screenHoldStatus(dir, { probe: async () => [win(2147480000)], alive: aliveOnlyMe });
    expect(st.held).toBe(false);
  });

  it("TC-D015-08 the code never reads the on-disk session record", () => {
    const t = fs.readFileSync(path.join("src", "browser", "screenHold.ts"), "utf8");
    expect(t).not.toMatch(/session\.json/);
    expect(t).not.toMatch(/\brecords\b/);
  });

  it("TC-D015-23 the enumeration output is parsed, a class name that is not plain is refused, and garbage lines are ignored", async () => {
    const out = `${CLASS}|4612\r\nnot a line\r\n${CLASS}|abc\r\nSomeOtherClass|77\r\n${CLASS}|0\r\n${CLASS}|55\r\n`;
    expect(parseProbeOutput(out, [CLASS])).toEqual([{ className: CLASS, pid: 4612 }, { className: CLASS, pid: 55 }]);
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await expect(probeOverlayWindows(["bad'class"], { platform: "win32", run })).rejects.toThrow(/class name/);
    expect(run).not.toHaveBeenCalled();
    const run2 = vi.fn(async () => ({ code: 0, stdout: `${CLASS}|9\n`, stderr: "" }));
    expect(await probeOverlayWindows([CLASS], { platform: "win32", run: run2 })).toEqual([{ className: CLASS, pid: 9 }]);
    const call = run2.mock.calls[0] as unknown as [string, string[], number];
    expect(call[0]).toMatch(/powershell/i);
    expect(call[1]).toContain("-EncodedCommand");
    await expect(probeOverlayWindows([CLASS], { platform: "win32", run: async () => ({ code: 1, stdout: "", stderr: "boom" }) })).rejects.toThrow(/boom/);
  });

  it.skipIf(process.platform !== "win32")("TC-D015-24 on Windows the real enumeration answers for a class nothing uses with an empty list and opens no window", async () => {
    expect(await probeOverlayWindows(["CcNoSuchWindowClass0000"])).toEqual([]);
  });
});

describe("REQ-D015 the manual hold", () => {
  it("TC-D015-09 cc hold set writes a manual hold that the status shows with its reason", async () => {
    setManualHold(dir, { reason: "school work on the screen" });
    expect(fs.existsSync(holdFilePath(dir))).toBe(true);
    const st = await screenHoldStatus(dir, { probe: async () => [] });
    expect(st.held).toBe(true);
    expect(st.reasons.join(" ")).toContain("school work on the screen");
  });

  it("TC-D015-10 cc hold clear removes it and says whether there was one", async () => {
    setManualHold(dir, {});
    expect(clearManualHold(dir)).toBe(true);
    expect(clearManualHold(dir)).toBe(false);
    expect((await screenHoldStatus(dir, { probe: async () => [] })).held).toBe(false);
  });

  it("TC-D015-11 a manual hold whose owner process is gone is stale, ignored and removed", async () => {
    setManualHold(dir, { ownerPid: 2147480001, reason: "left behind" });
    const st = await screenHoldStatus(dir, { probe: async () => [], alive: aliveOnlyMe });
    expect(st.held).toBe(false);
    expect(fs.existsSync(holdFilePath(dir))).toBe(false);
    expect(st.notes.join(" ")).toMatch(/stale/);
  });

  it("TC-D015-12 a manual hold without an owner pid stays until it is cleared", async () => {
    setManualHold(dir, { reason: "stays" });
    const deps: HoldDeps = { probe: async () => [], alive: () => false };
    expect((await screenHoldStatus(dir, deps)).held).toBe(true);
    expect((await screenHoldStatus(dir, deps)).held).toBe(true);
    setManualHold(dir, { ownerPid: ME });
    expect((await screenHoldStatus(dir, { probe: async () => [], alive: aliveOnlyMe })).held).toBe(true);
  });

  it("TC-D015-13 an unreadable hold file is ignored and removed", async () => {
    fs.writeFileSync(holdFilePath(dir), "{ this is not json");
    const st = await screenHoldStatus(dir, { probe: async () => [] });
    expect(st.held).toBe(false);
    expect(fs.existsSync(holdFilePath(dir))).toBe(false);
  });

  it("TC-D015-14 the reason is one line of at most 200 characters and a bad owner pid or subcommand is a usage error", async () => {
    const h = setManualHold(dir, { reason: "line one\nline two " + "x".repeat(400) });
    expect(h.reason).not.toMatch(/[\r\n]/);
    expect(h.reason.length).toBeLessThanOrEqual(200);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["hold", "set", "--owner-pid", "abc"])).toBe(2);
    expect(await main(["hold", "set", "--owner-pid", "-5"])).toBe(2);
    expect(await main(["hold", "bogus"])).toBe(2);
    expect(await main(["hold"])).toBe(2);
  });

  it("TC-D015-15 the hold command line sets, shows and clears through main with exit 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["hold", "set", "--reason", "screen in use", "--owner-pid", String(ME)])).toBe(0);
    expect(fs.existsSync(holdFilePath(dir))).toBe(true);
    log.mockClear();
    expect(await holdCommand(["status"], { probe: async () => [], alive: aliveOnlyMe })).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toMatch(/held/i);
    expect(log.mock.calls.flat().join("\n")).toContain("screen in use");
    log.mockClear();
    expect(await holdCommand(["status", "--json"], { probe: async () => [], alive: aliveOnlyMe })).toBe(0);
    const j = JSON.parse(String(log.mock.calls[0]![0]));
    expect(j.held).toBe(true);
    expect(await main(["hold", "clear"])).toBe(0);
    expect(fs.existsSync(holdFilePath(dir))).toBe(false);
    log.mockClear();
    expect(await main(["hold", "clear"])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toMatch(/no manual hold/i);
  });
});

describe("REQ-D015 what a waiting run does", () => {
  it("TC-D015-16 polling is never faster than 500 ms, even when asked for less", async () => {
    const c = fakeClock();
    const l = lines();
    await waitForScreenFree(dir, { probe: async () => (c.elapsed() < 5000 ? [win()] : []), alive: aliveOnlyMe, now: c.now, sleep: c.sleep, log: l.log, env: { CC_SCREEN_HOLD_POLL_MS: "10" } });
    expect(c.sleeps.length).toBeGreaterThan(0);
    for (const s of c.sleeps) expect(s).toBeGreaterThanOrEqual(500);
  });

  it("TC-D015-17 a waiting run says it waits and why, says it still waits every 60 s, and says how long it waited", async () => {
    const c = fakeClock();
    const l = lines();
    const r = await waitForScreenFree(dir, { probe: async () => (c.elapsed() < 150_000 ? [win()] : []), alive: aliveOnlyMe, now: c.now, sleep: c.sleep, log: l.log, env: {} });
    expect(r.waitedMs).toBe(150_000);
    expect(l.out[0]).toMatch(/waiting/);
    expect(l.out[0]).toContain(CLASS);
    expect(l.out.filter((m) => /still waiting after (60|120) s/.test(m)).length).toBe(2);
    expect(l.out.at(-1)).toMatch(/clear after waiting 150 s/);
  });

  it("TC-D015-18 the wait follows the condition: still held after ten minutes, goes on at the first poll after the clear", async () => {
    const c = fakeClock();
    const r = await waitForScreenFree(dir, { probe: async () => (c.elapsed() <= 600_500 ? [win()] : []), alive: aliveOnlyMe, now: c.now, sleep: c.sleep, log: () => {}, env: {} });
    expect(r.waitedMs).toBe(603_000);
    expect(new Set(c.sleeps)).toEqual(new Set([3000]));
  });

  it("TC-D015-19 a wait past the limit ends with an error naming the hold and the seconds, and returns no lane", async () => {
    const c = fakeClock();
    await expect(waitForScreenFree(dir, { probe: async () => [win()], alive: aliveOnlyMe, now: c.now, sleep: c.sleep, log: () => {}, env: { CC_SCREEN_HOLD_MAX_WAIT_MS: "10000" } }))
      .rejects.toThrow(/screen hold still set after \d+ s.*process/s);
    process.env.CC_SCREEN_HOLD_MAX_WAIT_MS = "1000";
    process.env.CC_SCREEN_HOLD_POLL_MS = "500";
    await expect(acquireLane({ hold: { probe: async () => [win()], alive: aliveOnlyMe, log: () => {} } })).rejects.toThrow(/screen hold still set/);
    expect(slots()).toEqual([]);
  });

  it("TC-D015-20 an enumeration that fails is said once and not counted, and a manual hold still holds", async () => {
    const l = lines();
    const c = fakeClock();
    const r0 = await waitForScreenFree(dir, { probe: async () => { throw new Error("enumeration timed out"); }, now: c.now, sleep: c.sleep, log: l.log, env: {} });
    expect(r0.waitedMs).toBe(0);
    expect(l.out.filter((m) => /could not read the windows/.test(m)).length).toBe(1);
    expect(l.out.join(" ")).toContain("enumeration timed out");

    setManualHold(dir, { ownerPid: ME, reason: "still here" });
    const l2 = lines();
    const c2 = fakeClock();
    const r = await waitForScreenFree(dir, {
      probe: async () => { throw new Error("enumeration timed out"); }, alive: aliveOnlyMe, now: c2.now, log: l2.log, env: {},
      sleep: async (ms) => { await c2.sleep(ms); if (c2.elapsed() >= 9000) clearManualHold(dir); },
    });
    expect(r.waitedMs).toBe(9000);
    expect(l2.out.filter((m) => /could not read the windows/.test(m)).length).toBe(1);
    expect(l2.out.join(" ")).toContain("still here");
  });

  it("TC-D015-21 CC_SCREEN_HOLD=off reads nothing and holds nothing", async () => {
    setManualHold(dir, { reason: "ignored while off" });
    const probe = vi.fn(async () => [win()]);
    const r = await waitForScreenFree(dir, { probe, alive: aliveOnlyMe, log: () => {}, env: { CC_SCREEN_HOLD: "off" } });
    expect(r.waitedMs).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(holdFilePath(dir))).toBe(true);
  });

  it("TC-D015-22 on a system that is not Windows the session source is empty and starts no process", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: `${CLASS}|1\n`, stderr: "" }));
    expect(await probeOverlayWindows([CLASS], { platform: "linux", run })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    setManualHold(dir, { reason: "manual works everywhere" });
    const st = await screenHoldStatus(dir, { probe: (c) => probeOverlayWindows(c, { platform: "linux", run }) });
    expect(st.held).toBe(true);
  });

  it("TC-D015-25 what the hold prints holds no environment value and no profile path", async () => {
    const c = fakeClock();
    const l = lines();
    setManualHold(dir, { ownerPid: ME, reason: "plain reason" });
    await waitForScreenFree(dir, {
      probe: async () => (c.elapsed() < 70_000 ? [win()] : []), alive: aliveOnlyMe, now: c.now, log: l.log, env: { SECRET_TOKEN: "s3cr3t-value" },
      sleep: async (ms) => { await c.sleep(ms); if (c.elapsed() >= 70_000) clearManualHold(dir); },
    });
    const all = l.out.join("\n");
    expect(all).not.toContain("s3cr3t-value");
    expect(all).not.toContain(dir);
    expect(all).not.toContain(os.tmpdir());
    if (process.env.USERPROFILE) expect(all).not.toContain(process.env.USERPROFILE);
    expect(all.length).toBeGreaterThan(0);
  });
});
