// @reqs REQ-D004 REQ-D007 REQ-D010
import { describe, expect, it } from "vitest";
import {
  GROK_LOGIN_TOTAL_WAIT_MS,
  grokLoginReached,
  humanCheckState,
  submitAndConfirmGrokLogin,
  TURNSTILE_TOKEN_INPUT,
  type LoginPage,
} from "../src/adapters/grokLoginWait.js";
import { onGrokHost } from "../src/adapters/grok.js";
import { chromeLaunchFlags } from "../src/browser/chrome.js";
import * as loginWait from "../src/adapters/grokLoginWait.js";

const SIGN_IN = "https://accounts.x.ai/sign-in?redirect=grok-com&email=true";

/**
 * A fake sign-in page driven by a script of "ticks": at each poll the clock advances and the script may change the
 * human check's token or decide what a Login press does. These REQ-D007 tests give cc no click or reload, so they
 * cover the submit-and-confirm wait alone; REQ-D010's own clicks and reloads are tested in grok-human-check.test.ts.
 */
function fakeLogin(opts: {
  /** token value of input[name=cf-turnstile-response] at time t (undefined = no such input). */
  token?: (t: number) => string | undefined;
  frames?: string[];
  /** what a Login press at time t does: navigate to a URL, or nothing. */
  onSubmit?: (t: number, n: number, token: string | undefined) => string | undefined;
}) {
  const clock = { t: 0 };
  let url = SIGN_IN;
  const presses: Array<{ t: number; token: string | undefined }> = [];
  const page: LoginPage = {
    url: () => url,
    locator: (sel: string) => ({
      first: () => ({
        count: async () => (sel === TURNSTILE_TOKEN_INPUT && opts.token && opts.token(clock.t) !== undefined ? 1 : 0),
        inputValue: async () => (sel === TURNSTILE_TOKEN_INPUT ? opts.token?.(clock.t) ?? "" : ""),
      }),
    }),
    frames: () => (opts.frames ?? []).map((u) => ({ url: () => u })),
  };
  const submit = async () => {
    const tok = opts.token?.(clock.t);
    presses.push({ t: clock.t, token: tok });
    const to = opts.onSubmit?.(clock.t, presses.length, tok);
    if (to) url = to;
  };
  const run = (o: Parameters<typeof submitAndConfirmGrokLogin>[2] = {}) =>
    submitAndConfirmGrokLogin(page, submit, { now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, ...o });
  return { page, presses, run, clock };
}

describe("grok login presses Login after the human check passes, then confirms grok.com (REQ-D007)", () => {
  it("the 2026-11-15 failure: check pending, then passed on its own -> Login is pressed only after it passed, and grok.com is reached", async () => {
    // pending for 30 s, then a pass token; a press with a valid token signs in.
    const f = fakeLogin({ token: (t) => (t < 30_000 ? "" : "tok-1"), onSubmit: (_t, _n, tok) => (tok ? "https://grok.com/" : undefined) });
    const out = await f.run();
    expect(f.presses).toHaveLength(1);
    expect(f.presses[0].t).toBeGreaterThanOrEqual(30_000);
    expect(f.presses[0].token).toBe("tok-1");
    expect(out.submits).toBe(1);
    expect(grokLoginReached(f.page.url())).toBe(true);
  });

  it("a press that does not leave the page is repeated when the check hands out a new pass token (bounded)", async () => {
    // first token is rejected by the form (stays on the page), widget re-solves with a new token, second press works.
    const f = fakeLogin({
      token: (t) => (t < 5_000 ? "tok-a" : t < 8_000 ? "" : "tok-b"),
      onSubmit: (_t, _n, tok) => (tok === "tok-b" ? "https://grok.com/" : undefined),
    });
    const out = await f.run();
    expect(f.presses.map((p) => p.token)).toEqual(["tok-a", "tok-b"]);
    expect(out.submits).toBe(2);
  });

  it("never presses Login while the check is pending, and reports a check that never passes precisely (no click or reload given: the REQ-D007 wait)", async () => {
    const f = fakeLogin({ token: () => "", frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if"] });
    await expect(f.run({ totalWaitMs: 60_000 })).rejects.toThrow(/did not reach grok\.com within 60s: Login pressed 0 time\(s\); human check pending; attempts: auto-solve wait 10s, clicked the check 0 time\(s\) \(methods: none\), reloaded 0 time\(s\) over 1 page load\(s\); page https:\/\/accounts\.x\.ai\/sign-in/);
    expect(f.presses).toHaveLength(0);
  });

  it("with no human check, Login is pressed at once and repeated at most maxSubmits times, then fails with the count", async () => {
    const f = fakeLogin({});
    await expect(f.run({ totalWaitMs: 200_000, resubmitMs: 20_000, maxSubmits: 3 })).rejects.toThrow(/Login pressed 3 time\(s\); human check none/);
    expect(f.presses).toHaveLength(3);
    expect(f.presses[0].t).toBe(0);
  });

  it("the error never carries the query string of the page (no tokens or emails in errors)", async () => {
    const f = fakeLogin({ token: () => "" });
    const err = await f.run({ totalWaitMs: 3_000 }).catch((e: Error) => e.message);
    expect(err).toMatch(/page https:\/\/accounts\.x\.ai\/sign-in$/);
    expect(err).not.toMatch(/redirect=|email=/);
  });

  it("humanCheckState reads Turnstile's own form field and never clicks anything", async () => {
    expect((await humanCheckState(fakeLogin({ token: () => "" }).page)).state).toBe("pending");
    expect(await humanCheckState(fakeLogin({ token: () => "abc" }).page)).toEqual({ state: "passed", token: "abc" });
    expect((await humanCheckState(fakeLogin({}).page)).state).toBe("none");
    expect((await humanCheckState(fakeLogin({ frames: ["https://challenges.cloudflare.com/x"] }).page)).state).toBe("pending");
  });

  it("cc has its own click for the human check and no longer exports the v0.2.17 one-shot helpers (REQ-D010)", () => {
    expect(Object.keys(loginWait)).toContain("clickTurnstileCheckbox");
    expect(Object.keys(loginWait)).not.toContain("clickTurnstileOnce");
    expect(Object.keys(loginWait)).not.toContain("waitForGrokLoginRedirect");
  });

  it("grok.com is reached only by host and path, never by a substring of the URL", () => {
    expect(grokLoginReached("https://grok.com/")).toBe(true);
    expect(grokLoginReached("https://grok.com/connectors")).toBe(true);
    expect(grokLoginReached("https://accounts.x.ai/account")).toBe(true);
    expect(grokLoginReached(SIGN_IN)).toBe(false);
    expect(grokLoginReached("https://accounts.x.ai/sign-in?next=https://grok.com/")).toBe(false);
    expect(grokLoginReached("https://grok.com.evil.example/")).toBe(false);
    expect(grokLoginReached("http://grok.com/")).toBe(false);
  });

  it("a signed-out redirect to accounts.x.ai is never taken for a signed-in grok.com (the retry's ACCOUNT_NOT_AUTHORIZED of 2026-11-15)", () => {
    expect(onGrokHost("https://grok.com/connectors")).toBe(true);
    expect(onGrokHost(SIGN_IN)).toBe(false);
    expect(onGrokHost("about:blank")).toBe(false);
  });

  it("the whole login stays bounded at 10 minutes", () => {
    expect(GROK_LOGIN_TOTAL_WAIT_MS).toBe(10 * 60 * 1000);
  });
});

describe("cc Chrome is visible (headful) by default (REQ-D004)", () => {
  it("TC-D010-29 the real run's Chrome stays headful (REQ-D004 launch flags)", () => {
    const plain = chromeLaunchFlags({ CC_CHROME_EXTRA_ARGS: undefined });
    expect(plain.windowsHide).toBe(false);
    expect(plain.headless).toBe(false);
    expect(plain.args.join(" ")).not.toMatch(/--headless/);
    const headed = chromeLaunchFlags({ CC_CHROME_EXTRA_ARGS: "--window-size=1200,800" });
    expect(headed.headless).toBe(false);
    const testMode = chromeLaunchFlags({ CC_CHROME_EXTRA_ARGS: "--headless=new --no-sandbox" });
    expect(testMode.headless).toBe(true);
    expect(testMode.windowsHide).toBe(false);
  });
});
