// @reqs REQ-D010 REQ-D007 REQ-D004
/**
 * REQ-D010: cc gets past grok.com's Cloudflare human check by itself (auto-solve wait, then its own click on the
 * checkbox, then a reload), and fails with an exact error only after every automated attempt. Each test name starts
 * with its test case id from docs/requirements.yaml (REQ-D010 test_cases).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clickTurnstileCheckbox,
  grokLoginReached,
  GROK_LOGIN_TOTAL_WAIT_MS,
  GROK_TURNSTILE_AUTO_SOLVE_MS,
  GROK_TURNSTILE_CHECKBOX_X,
  GROK_TURNSTILE_MAX_CLICKS,
  GROK_TURNSTILE_MAX_RELOADS,
  submitAndConfirmGrokLogin,
  TURNSTILE_IFRAME,
  TURNSTILE_TOKEN_INPUT,
  TURNSTILE_WIDGET_BOX,
  type ClickPage,
  type ClickResult,
  type LoginPage,
} from "../src/adapters/grokLoginWait.js";

const SIGN_IN = "https://accounts.x.ai/sign-in?redirect=grok-com&email=true";
const TURNSTILE_FRAME_URL = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/normal";

interface World { t: number; load: number; clicks: number; goodClicks: number; presses: number; reloadCalls: number }

/**
 * A fake sign-in page on a fake clock. The human check's token is a function of the world (time, page load, cc's
 * clicks so far, Login presses, reload calls), so a test can say "passes after the first click" or "passes on the
 * second page load". cc's click and reload are injected callbacks; the fake records every call.
 */
function fake(o: {
  token?: (w: World) => string | undefined;
  onSubmit?: (w: World, token: string | undefined) => string | undefined;
  click?: (n: number) => ClickResult | "throw";
  reloadThrows?: (n: number) => boolean;
  url?: string;
} = {}) {
  const w: World = { t: 0, load: 1, clicks: 0, goodClicks: 0, presses: 0, reloadCalls: 0 };
  let url = o.url ?? SIGN_IN;
  const presses: Array<{ t: number; token: string | undefined }> = [];
  const clickTimes: number[] = [];
  const reloadTimes: number[] = [];
  const sleeps: number[] = [];
  const steps: string[] = [];
  const tok = () => o.token?.(w);
  const page: LoginPage = {
    url: () => url,
    locator: (sel: string) => ({
      first: () => ({
        count: async () => (sel === TURNSTILE_TOKEN_INPUT && tok() !== undefined ? 1 : 0),
        inputValue: async () => (sel === TURNSTILE_TOKEN_INPUT ? tok() ?? "" : ""),
      }),
    }),
    frames: () => (tok() !== undefined ? [{ url: () => TURNSTILE_FRAME_URL }] : []),
  };
  const submit = async () => {
    const t = tok();
    presses.push({ t: w.t, token: t });
    w.presses++;
    const to = o.onSubmit?.(w, t);
    if (to) url = to;
  };
  const clickCheck = async (): Promise<ClickResult> => {
    clickTimes.push(w.t);
    w.clicks++;
    const r = o.click ? o.click(w.clicks) : { clicked: true, method: "frame-checkbox" as const };
    if (r === "throw") throw new Error("click failed");
    if (r.clicked) w.goodClicks++;
    return r;
  };
  const reload = async () => {
    reloadTimes.push(w.t);
    w.reloadCalls++;
    if (o.reloadThrows?.(w.reloadCalls)) throw new Error("reload failed");
    w.load++;
    url = o.url ?? SIGN_IN;
  };
  const run = (opts: Parameters<typeof submitAndConfirmGrokLogin>[2] = {}) =>
    submitAndConfirmGrokLogin(page, submit, {
      now: () => w.t,
      // a runaway loop (a bound that never trips) fails the test instead of spinning forever
      sleep: async (ms) => { sleeps.push(ms); w.t += ms; if (w.t > 3_600_000) throw new Error("runaway: fake clock passed one hour"); },
      clickCheck,
      reload,
      onStep: (l) => steps.push(l),
      mode: "headful",
      ...opts,
    });
  return { w, page, presses, clickTimes, reloadTimes, sleeps, steps, run };
}

const toGrok = (_w: World, t: string | undefined) => (t ? "https://grok.com/" : undefined);
const never = () => "";

describe("REQ-D010 AC1: the auto-solve window comes first", () => {
  it("TC-D010-01 auto-solved inside the window: no click, one Login press with that token, outcome auto-solved", async () => {
    const f = fake({ token: (w) => (w.t < 5_000 ? "" : "tok-1"), onSubmit: toGrok });
    const out = await f.run();
    expect(f.clickTimes).toHaveLength(0);
    expect(out.clicks).toBe(0);
    expect(out.outcome).toBe("auto-solved");
    expect(f.presses.map((p) => p.token)).toEqual(["tok-1"]);
    expect(grokLoginReached(f.page.url())).toBe(true);
  });

  it("TC-D010-02 no click before the auto-solve window ends", async () => {
    expect(GROK_TURNSTILE_AUTO_SOLVE_MS).toBe(10_000);
    const f = fake({ token: never });
    await expect(f.run({ totalWaitMs: GROK_TURNSTILE_AUTO_SOLVE_MS - 500 })).rejects.toThrow(/did not reach grok\.com/);
    expect(f.clickTimes).toHaveLength(0);
  });

  it("TC-D010-03 a page with no human check is never clicked and Login is pressed at once", async () => {
    const f = fake({ onSubmit: () => "https://grok.com/" });
    const out = await f.run();
    expect(f.clickTimes).toHaveLength(0);
    expect(f.presses).toHaveLength(1);
    expect(f.presses[0].t).toBe(0);
    expect(out.outcome).toBe("none");
  });
});

describe("REQ-D010 AC2: cc clicks the check itself, bounded", () => {
  it("TC-D010-04 still pending after the window: cc clicks once, the check passes, outcome passed-after-click", async () => {
    const f = fake({ token: (w) => (w.goodClicks >= 1 ? "tok" : ""), onSubmit: toGrok });
    const out = await f.run();
    expect(f.clickTimes).toHaveLength(1);
    expect(f.clickTimes[0]).toBeGreaterThanOrEqual(GROK_TURNSTILE_AUTO_SOLVE_MS);
    expect(out.clicks).toBe(1);
    expect(out.clickMethods).toEqual(["frame-checkbox"]);
    expect(out.outcome).toBe("passed-after-click");
  });

  it("TC-D010-05 a first click with no effect is followed by a second click after the retry window, then the pass", async () => {
    const f = fake({ token: (w) => (w.goodClicks >= 2 ? "tok" : ""), onSubmit: toGrok });
    const out = await f.run({ clickRetryMs: 10_000 });
    expect(f.clickTimes).toHaveLength(2);
    expect(f.clickTimes[1] - f.clickTimes[0]).toBeGreaterThanOrEqual(10_000);
    expect(out.clicks).toBe(2);
    expect(grokLoginReached(f.page.url())).toBe(true);
  });

  it("TC-D010-06 a check that has passed is never clicked", async () => {
    const f = fake({ token: (w) => (w.t < 3_000 ? "" : "tok"), onSubmit: () => undefined });
    await expect(f.run({ totalWaitMs: 120_000 })).rejects.toThrow(/did not reach grok\.com/);
    expect(f.clickTimes).toHaveLength(0);
  });

  it("TC-D010-07 a click that throws or finds nothing is counted and the loop goes on", async () => {
    const f = fake({
      token: (w) => (w.goodClicks >= 1 ? "tok" : ""),
      onSubmit: toGrok,
      click: (n) => (n === 1 ? "throw" : n === 2 ? { clicked: false, method: "none" } : { clicked: true, method: "widget-box" }),
    });
    const out = await f.run();
    expect(out.clicks).toBe(3);
    expect(out.clickMethods).toEqual(["error", "none", "widget-box"]);
    expect(grokLoginReached(f.page.url())).toBe(true);
  });

  it("TC-D010-08 at most maxClicks clicks per page load", async () => {
    const f = fake({ token: never });
    await expect(f.run({ maxClicks: 3, maxReloads: 0 })).rejects.toThrow(/clicked the check 3 time\(s\)/);
    expect(f.clickTimes).toHaveLength(3);
    expect(f.reloadTimes).toHaveLength(0);
  });
});

/** A fake page for clickTurnstileCheckbox: what each strategy can find, and a log of what was clicked. */
function clickPage(o: { frameCheckbox?: "ok" | "missing" | "throws"; iframeBox?: { x: number; y: number; width: number; height: number } | null; widgetBox?: { x: number; y: number; width: number; height: number } | null }) {
  const log: Array<string | [string, number, number]> = [];
  const box = (b: typeof o.iframeBox, name: string) => ({
    count: async () => (b ? 1 : 0),
    boundingBox: async () => b ?? null,
    click: async () => { log.push(name); },
  });
  const page: ClickPage = {
    frames: () => (o.frameCheckbox ? [{
      url: () => TURNSTILE_FRAME_URL,
      locator: () => ({ first: () => ({
        count: async () => (o.frameCheckbox === "missing" ? 0 : 1),
        click: async () => { if (o.frameCheckbox === "throws") throw new Error("detached"); log.push("frame-checkbox"); },
      }) }),
    }] : []),
    locator: (sel: string) => ({ first: () => (sel === TURNSTILE_IFRAME ? box(o.iframeBox ?? null, "iframe") : sel === TURNSTILE_WIDGET_BOX ? box(o.widgetBox ?? null, "widget") : box(null, "other")) }),
    mouse: { move: async () => undefined, click: async (x: number, y: number) => { log.push(["mouse", x, y]); } },
  };
  return { page, log };
}

describe("REQ-D010 AC3: how cc clicks the checkbox", () => {
  it("TC-D010-09 the checkbox inside the challenges.cloudflare.com frame is clicked first", async () => {
    const c = clickPage({ frameCheckbox: "ok", iframeBox: { x: 100, y: 200, width: 300, height: 65 }, widgetBox: { x: 100, y: 200, width: 300, height: 65 } });
    expect(await clickTurnstileCheckbox(c.page)).toEqual({ clicked: true, method: "frame-checkbox" });
    expect(c.log).toEqual(["frame-checkbox"]);
  });

  it("TC-D010-10 falls back to the widget iframe element when the frame checkbox cannot be clicked", async () => {
    for (const fc of ["missing", "throws"] as const) {
      const c = clickPage({ frameCheckbox: fc, iframeBox: { x: 100, y: 200, width: 300, height: 65 } });
      expect(await clickTurnstileCheckbox(c.page)).toEqual({ clicked: true, method: "iframe-element" });
      expect(c.log).toEqual([["mouse", 100 + GROK_TURNSTILE_CHECKBOX_X, 232.5]]);
    }
  });

  it("TC-D010-11 falls back to the widget box holding cf-turnstile-response, clicking at the checkbox position", async () => {
    const c = clickPage({ widgetBox: { x: 10, y: 20, width: 300, height: 65 } });
    expect(await clickTurnstileCheckbox(c.page)).toEqual({ clicked: true, method: "widget-box" });
    expect(c.log).toEqual([["mouse", 10 + GROK_TURNSTILE_CHECKBOX_X, 52.5]]);
  });

  it("TC-D010-12 no widget at all: clicked false, method none, nothing is clicked", async () => {
    const c = clickPage({});
    expect(await clickTurnstileCheckbox(c.page)).toEqual({ clicked: false, method: "none" });
    expect(c.log).toEqual([]);
  });
});

describe("REQ-D010 AC4: reload and refill, bounded", () => {
  it("TC-D010-13 still pending after maxClicks: reload and refill, then the check passes on the new page load", async () => {
    const f = fake({ token: (w) => (w.load >= 2 ? "tok" : ""), onSubmit: toGrok });
    const out = await f.run();
    expect(f.clickTimes).toHaveLength(3);
    expect(f.reloadTimes).toHaveLength(1);
    expect(f.reloadTimes[0]).toBeGreaterThan(f.clickTimes[2]);
    expect(out.reloads).toBe(1);
    expect(out.outcome).toBe("passed-after-reload");
    expect(grokLoginReached(f.page.url())).toBe(true);
  });

  it("TC-D010-14 no reload before the clicks of that page load are used", async () => {
    const f = fake({ token: (w) => (w.goodClicks >= 3 ? "tok" : ""), onSubmit: toGrok });
    const out = await f.run();
    expect(f.reloadTimes).toHaveLength(0);
    expect(out.clicks).toBe(3);
  });

  it("TC-D010-15 a reload that throws is counted and the loop goes on", async () => {
    const f = fake({ token: (w) => (w.load >= 2 ? "tok" : ""), onSubmit: toGrok, reloadThrows: (n) => n === 1 });
    const out = await f.run();
    expect(f.reloadTimes).toHaveLength(2);
    expect(out.reloads).toBe(2);
    expect(grokLoginReached(f.page.url())).toBe(true);
  });

  it("TC-D010-16 at most maxReloads reloads", async () => {
    const f = fake({ token: never });
    await expect(f.run()).rejects.toThrow(/reloaded 2 time\(s\)/);
    expect(f.reloadTimes).toHaveLength(GROK_TURNSTILE_MAX_RELOADS);
  });
});

describe("REQ-D010 AC5: Login after the pass (REQ-D007 kept)", () => {
  it("TC-D010-17 after a pass that followed a click, Login is pressed with the pass token and grok.com is reached", async () => {
    const f = fake({ token: (w) => (w.goodClicks >= 1 ? "tok-c" : ""), onSubmit: (_w, t) => (t === "tok-c" ? "https://grok.com/" : undefined) });
    await f.run();
    expect(f.presses.map((p) => p.token)).toEqual(["tok-c"]);
    expect(grokLoginReached(f.page.url())).toBe(true);
  });

  it("TC-D010-18 Login is never pressed while the check is pending", async () => {
    const f = fake({ token: (w) => (w.load >= 2 ? "tok" : ""), onSubmit: toGrok });
    await f.run();
    expect(f.presses.length).toBeGreaterThan(0);
    for (const p of f.presses) expect(p.token).toBeTruthy();
  });

  it("TC-D010-19 a pass token the form rejects is followed by a press on the fresh token (REQ-D007 kept)", async () => {
    const f = fake({
      token: (w) => (w.goodClicks < 1 ? "" : w.presses < 1 ? "tok-a" : "tok-b"),
      onSubmit: (_w, t) => (t === "tok-b" ? "https://grok.com/" : undefined),
    });
    const out = await f.run();
    expect(f.presses.map((p) => p.token)).toEqual(["tok-a", "tok-b"]);
    expect(out.clicks).toBe(1);
  });
});

describe("REQ-D010 AC6: fail fast with every attempt named, never wait for a person", () => {
  it("TC-D010-20 every attempt used: fails at once, well before the 10-minute bound, naming every attempt", async () => {
    const f = fake({ token: never });
    const err = await f.run().then(() => "", (e: Error) => e.message);
    expect(err).toMatch(/grok\.com human check did not pass after every automated attempt/);
    expect(err).toMatch(/auto-solve wait 10s/);
    expect(err).toMatch(/clicked the check 9 time\(s\) \(methods: frame-checkbox/);
    expect(err).toMatch(/reloaded 2 time\(s\) over 3 page load\(s\)/);
    expect(err).toMatch(/Login pressed 0 time\(s\)/);
    expect(f.w.t).toBeLessThan(GROK_LOGIN_TOTAL_WAIT_MS / 2);
  });

  it("TC-D010-21 the error never asks a person to act and never says cc does not click", async () => {
    const f = fake({ token: never });
    const err = await f.run().then(() => "", (e: Error) => e.message);
    expect(err).not.toBe("");
    expect(err).not.toMatch(/visible window|human at|a person|by hand|operator|tap it|never clicks|does not click/i);
  });

  it("TC-D010-22 the 10-minute bound error lists the same attempts", async () => {
    const f = fake({ token: never });
    const err = await f.run({ totalWaitMs: 25_000 }).then(() => "", (e: Error) => e.message);
    expect(err).toMatch(/did not reach grok\.com within 25s/);
    expect(err).toMatch(/auto-solve wait 10s/);
    expect(err).toMatch(/clicked the check \d time\(s\)/);
    expect(err).toMatch(/reloaded 0 time\(s\) over 1 page load\(s\)/);
  });
});

describe("REQ-D010 AC7/AC8: one step line per login for the run log, no secrets", () => {
  it("TC-D010-23 a passed login reports one step line with mode, outcome, clicks, methods, reloads, presses, confirmed host and waited ms", async () => {
    const f = fake({ token: (w) => (w.goodClicks >= 1 ? "tok" : ""), onSubmit: toGrok });
    await f.run();
    expect(f.steps).toHaveLength(1);
    expect(f.steps[0]).toMatch(/^grok-login mode=headful human-check=passed-after-click clicks=1 click-methods=frame-checkbox reloads=0 page-loads=1 login-presses=1 confirmed=grok\.com waited-ms=\d+$/);
  });

  it("TC-D010-24 a failed login reports one step line with human-check=failed", async () => {
    const f = fake({ token: never });
    await f.run().catch(() => undefined);
    expect(f.steps).toHaveLength(1);
    expect(f.steps[0]).toMatch(/^grok-login mode=headful human-check=failed clicks=9 click-methods=frame-checkbox(,frame-checkbox){8} reloads=2 page-loads=3 login-presses=0 confirmed=no waited-ms=\d+ error=human-check-exhausted$/);
  });

  it("TC-D010-27 errors and step lines carry no query string, email or token", async () => {
    const f = fake({ token: () => "SECRETTOKEN123", onSubmit: () => undefined, url: "https://accounts.x.ai/sign-in?redirect=grok-com&email=someone%40example.com" });
    const err = await f.run({ totalWaitMs: 100_000 }).then(() => "", (e: Error) => e.message);
    const all = [err, ...f.steps].join("\n");
    expect(err).toMatch(/page https:\/\/accounts\.x\.ai\/sign-in$/);
    expect(all).not.toMatch(/SECRETTOKEN123|redirect=|email=|example\.com|\?/);
  });
});

describe("REQ-D010 AC9/AC10: bounded, wired, and the ledger says what cc does", () => {
  it("TC-D010-28 the defaults bound total clicks at maxClicks x (1 + maxReloads) and polling at 500 ms or slower", async () => {
    expect(GROK_TURNSTILE_MAX_CLICKS).toBe(3);
    expect(GROK_TURNSTILE_MAX_RELOADS).toBe(2);
    const f = fake({ token: never });
    await f.run({ pollMs: 10 }).catch(() => undefined);
    expect(f.clickTimes.length).toBe(GROK_TURNSTILE_MAX_CLICKS * (1 + GROK_TURNSTILE_MAX_RELOADS));
    expect(Math.min(...f.sleeps)).toBeGreaterThanOrEqual(500);
  });

  it("TC-D010-30 grok.ts wires cc's own click and reload into the login", () => {
    const src = fs.readFileSync(path.resolve("src", "adapters", "grok.ts"), "utf8");
    expect(src).toMatch(/clickCheck:\s*\(\)\s*=>\s*clickTurnstileCheckbox\(/);
    expect(src).toMatch(/reload:\s*/);
    expect(src).toMatch(/onStep:\s*reportStep/);
  });

  it("TC-D010-31 the ledger no longer says cc never clicks the check or that a human at the machine finishes it", () => {
    const led = fs.readFileSync(path.resolve("docs", "requirements.yaml"), "utf8").replace(/\r\n/g, "\n");
    const entry = (id: string) => { const i = led.indexOf(`- id: ${id}\n`); const j = led.indexOf("\n- id: ", i + 1); return led.slice(i, j < 0 ? undefined : j); };
    for (const id of ["REQ-D004", "REQ-D007"]) {
      const e = entry(id);
      expect(e.length).toBeGreaterThan(50);
      expect(e).not.toMatch(/never clicks|human at that machine|a human .{0,40}can finish/i);
    }
    expect(entry("REQ-D010")).toMatch(/clicks the Turnstile checkbox itself/);
  });
});
