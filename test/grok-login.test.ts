// @reqs REQ-D004
import { describe, expect, it } from "vitest";
import {
  clickTurnstileOnce,
  GROK_LOGIN_TOTAL_WAIT_MS,
  iframeTurnstilePresent,
  waitForGrokLoginRedirect,
  type LoginPage,
} from "../src/adapters/grokLoginWait.js";
import { chromeLaunchFlags } from "../src/browser/chrome.js";

function fakePage(init: {
  url?: string;
  frames?: string[];
  iframe?: boolean;
  redirectAfter?: { ms: number; url: string };
  now?: { t: number };
}): LoginPage & { clicks: string[]; waitTimeouts: number[] } {
  const state = {
    url: init.url ?? "https://accounts.x.ai/sign-in?redirect=grok-com&email=true",
    frames: [...(init.frames ?? [])],
    iframe: !!init.iframe,
    clicks: [] as string[],
    waitTimeouts: [] as number[],
  };
  const clock = init.now ?? { t: 0 };
  const loc = (name: string) => ({
    first: () => ({
      count: async () => (state.iframe && /iframe/.test(name) ? 1 : 0),
      click: async () => { state.clicks.push(name); },
    }),
  });
  return {
    clicks: state.clicks,
    waitTimeouts: state.waitTimeouts,
    url: () => state.url,
    locator: loc,
    frames: () => state.frames.map((u) => ({ url: () => u, locator: loc })),
    async waitForURL(pattern, opts) {
      state.waitTimeouts.push(opts.timeout);
      const delay = init.redirectAfter?.ms;
      if (delay !== undefined && opts.timeout >= delay && pattern.test(init.redirectAfter!.url)) {
        clock.t += delay;
        state.url = init.redirectAfter!.url;
        state.frames = [];
        state.iframe = false;
        return;
      }
      clock.t += opts.timeout;
      throw new Error(`Timeout ${opts.timeout}ms exceeded`);
    },
  };
}

describe("grok login Turnstile wait (REQ-D004)", () => {
  it("if the redirect happens during the auto-wait, the Turnstile is never clicked", async () => {
    const page = fakePage({
      iframe: true,
      frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/x"],
      redirectAfter: { ms: 5, url: "https://grok.com/" },
    });
    await waitForGrokLoginRedirect(page, { autoWaitMs: 20, totalWaitMs: 100 });
    expect(page.clicks).toEqual([]);
    expect(page.url()).toBe("https://grok.com/");
    expect(page.waitTimeouts[0]).toBe(20);
  });

  it("if Turnstile is still up after the auto-wait, it is clicked once, then the remaining time is used", async () => {
    const page = fakePage({
      iframe: true,
      frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/x"],
      redirectAfter: { ms: 50, url: "https://accounts.x.ai/account" },
    });
    await waitForGrokLoginRedirect(page, { autoWaitMs: 20, totalWaitMs: 100 });
    expect(page.clicks).toHaveLength(1);
    expect(page.url()).toBe("https://accounts.x.ai/account");
    expect(page.waitTimeouts[0]).toBe(20);
    expect(page.waitTimeouts[1]).toBeGreaterThan(0);
    expect(page.waitTimeouts[1]).toBeLessThanOrEqual(100);
    expect(page.waitTimeouts[0] + page.waitTimeouts[1]).toBeLessThanOrEqual(120);
  });

  it("Turnstile is not clicked when it is not present; the long wait still runs after a short auto-wait miss", async () => {
    const page = fakePage({
      redirectAfter: { ms: 40, url: "https://grok.com/connectors" },
    });
    await waitForGrokLoginRedirect(page, { autoWaitMs: 10, totalWaitMs: 80 });
    expect(page.clicks).toEqual([]);
    expect(await iframeTurnstilePresent(page)).toBe(false);
    expect(page.url()).toBe("https://grok.com/connectors");
  });

  it("clickTurnstileOnce only attempts a single click", async () => {
    const page = fakePage({ iframe: true, frames: ["https://challenges.cloudflare.com/turnstile"] });
    expect(await clickTurnstileOnce(page)).toBe(true);
    expect(page.clicks).toHaveLength(1);
    expect(await clickTurnstileOnce(page)).toBe(true);
    expect(page.clicks).toHaveLength(2); // each call is one click; login calls it once
  });

  it("the default remaining wait after a missed auto-solve is 10 minutes", () => {
    expect(GROK_LOGIN_TOTAL_WAIT_MS).toBe(10 * 60 * 1000);
  });
});

describe("cc Chrome is visible (headful) by default (REQ-D004)", () => {
  it("launch flags do not add --headless and windowsHide is false unless CC_CHROME_EXTRA_ARGS asks for headless", () => {
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
