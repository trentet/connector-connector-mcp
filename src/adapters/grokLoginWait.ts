// @reqs REQ-D004 REQ-D007 REQ-D010
/**
 * The grok.com email-and-password login: get past the human check (Cloudflare Turnstile) by cc itself, press Login
 * once it has passed, then confirm the browser reached grok.com. The runner then reads the signed-in account and its
 * login method and refuses to act unless they are exactly the run's account with an email login (ACCT-C05, ACCT-C10).
 *
 * REQ-D010 (amends REQ-D004 and REQ-D007, owner t166u 2026-11-15): the operator never has to click the check. In the
 * headful Chrome the check often passes on its own, so cc first waits a short auto-solve window. If it is still
 * pending, cc clicks the Turnstile checkbox itself (clickTurnstileCheckbox: the checkbox in the challenge frame, else
 * the widget iframe, else the widget box), bounded per page load; then it reloads the sign-in page and refills the
 * form, bounded. Only when every automated attempt is used does the login fail, at once, with an error that names
 * each attempt. The check's state is read from Turnstile's own form field (input[name="cf-turnstile-response"]: empty
 * while pending, a token once passed). REQ-D007 kept: Login is pressed only after the pass (or with no check), and
 * pressed again (bounded) when a fresh pass token appears after a press that did not leave the page.
 * Reused: the click strategies of cc v0.2.17 (5a0b4b8, clickTurnstileOnce); the "three different attempts, each
 * with its result" shape of helm-report-templates scripts/lib/human-check.mjs (RPT-BLD-060).
 */

export const GROK_LOGIN_TOTAL_WAIT_MS = 10 * 60_000;
/** Poll interval; cc never busy-waits (500 ms or slower). */
export const GROK_LOGIN_POLL_MS = 1000;
/** With no human check on the page, a press that has not left the page after this long is repeated. */
export const GROK_LOGIN_RESUBMIT_MS = 20_000;
/** REQ-D007: Login presses per page load. */
export const GROK_LOGIN_MAX_SUBMITS = 4;
/** REQ-D010: how long a pending check may auto-solve before cc clicks it (per page load). */
export const GROK_TURNSTILE_AUTO_SOLVE_MS = 10_000;
/** REQ-D010: after a click, how long cc waits for a pass before the next click (or the reload). */
export const GROK_TURNSTILE_CLICK_RETRY_MS = 10_000;
/** REQ-D010: clicks per page load. */
export const GROK_TURNSTILE_MAX_CLICKS = 3;
/** REQ-D010: reloads of the sign-in page. */
export const GROK_TURNSTILE_MAX_RELOADS = 2;
/** REQ-D010: the checkbox sits this many px from the widget's left edge, vertically centred (Turnstile's 300x65 widget). */
export const GROK_TURNSTILE_CHECKBOX_X = 30;
export const TURNSTILE_TOKEN_INPUT = 'input[name="cf-turnstile-response"]';
export const TURNSTILE_FRAME = /challenges\.cloudflare\.com|turnstile/i;
/** REQ-D010: the widget's iframe element (when the page's DOM exposes it). */
export const TURNSTILE_IFRAME = 'iframe[src*="challenges.cloudflare.com"]';
/** REQ-D010: the widget box: the element that holds Turnstile's hidden response input. */
export const TURNSTILE_WIDGET_BOX = 'div:has(> input[name="cf-turnstile-response"])';
const FRAME_CHECKBOX = 'input[type="checkbox"], [role="checkbox"]';

export interface LoginPage {
  url(): string;
  locator(selector: string): { first(): { count(): Promise<number>; inputValue(opts?: { timeout?: number }): Promise<string> } };
  frames(): Array<{ url(): string }>;
}

export type HumanCheck = "none" | "pending" | "passed";

/** Signed in means the browser is on grok.com itself (or x.ai's own account page), judged by host and path, never by a substring of the URL. */
export function grokLoginReached(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "grok.com" || h.endsWith(".grok.com")) return true;
  return h === "accounts.x.ai" && /^\/account(\/|$)/.test(u.pathname);
}

/** Read the human check's state from the page (reading only; clicking is clickTurnstileCheckbox). */
export async function humanCheckState(page: LoginPage): Promise<{ state: HumanCheck; token?: string }> {
  const input = page.locator(TURNSTILE_TOKEN_INPUT).first();
  let present = false;
  try { present = (await input.count()) > 0; } catch { present = false; }
  if (present) {
    const token = (await input.inputValue({ timeout: 2000 }).catch(() => "")).trim();
    return token ? { state: "passed", token } : { state: "pending" };
  }
  return page.frames().some((f) => TURNSTILE_FRAME.test(f.url())) ? { state: "pending" } : { state: "none" };
}

export type ClickMethod = "frame-checkbox" | "iframe-element" | "widget-box" | "none";
export interface ClickResult { clicked: boolean; method: ClickMethod }

type Box = { x: number; y: number; width: number; height: number };
export interface ClickPage {
  frames(): Array<{ url(): string; locator(selector: string): { first(): { count(): Promise<number>; click(opts?: { timeout?: number; delay?: number }): Promise<void> } } }>;
  locator(selector: string): { first(): { count(): Promise<number>; boundingBox(): Promise<Box | null> } };
  mouse: { move(x: number, y: number, opts?: { steps?: number }): Promise<void>; click(x: number, y: number, opts?: { delay?: number }): Promise<void> };
}

/** REQ-D010: a person's click on the checkbox at its position inside a widget box: move in, then press. */
async function clickBox(page: ClickPage, b: Box): Promise<void> {
  const x = b.x + GROK_TURNSTILE_CHECKBOX_X;
  const y = b.y + b.height / 2;
  await page.mouse.move(x - 40, y - 12).catch(() => undefined);
  await page.mouse.move(x, y, { steps: 8 }).catch(() => undefined);
  await page.mouse.click(x, y, { delay: 90 });
}

/**
 * REQ-D010: cc clicks the Turnstile checkbox itself. In order: the checkbox inside the challenges.cloudflare.com frame;
 * else the widget's iframe element; else the widget box that holds cf-turnstile-response. Returns which one worked;
 * with no widget it clicks nothing and returns { clicked: false, method: "none" }.
 */
export async function clickTurnstileCheckbox(page: ClickPage): Promise<ClickResult> {
  for (const frame of page.frames()) {
    if (!/challenges\.cloudflare\.com/i.test(frame.url())) continue;
    try {
      const box = frame.locator(FRAME_CHECKBOX).first();
      if ((await box.count()) > 0) {
        await box.click({ timeout: 5000, delay: 90 });
        return { clicked: true, method: "frame-checkbox" };
      }
    } catch { /* fall through to the iframe element */ }
  }
  for (const [sel, method] of [[TURNSTILE_IFRAME, "iframe-element"], [TURNSTILE_WIDGET_BOX, "widget-box"]] as const) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) continue;
      const b = await el.boundingBox();
      if (!b || b.width <= 0 || b.height <= 0) continue;
      await clickBox(page, b);
      return { clicked: true, method };
    } catch { /* try the next way */ }
  }
  return { clicked: false, method: "none" };
}

export interface SubmitOpts {
  totalWaitMs?: number;
  pollMs?: number;
  resubmitMs?: number;
  maxSubmits?: number;
  /** REQ-D010 */
  autoSolveMs?: number;
  clickRetryMs?: number;
  maxClicks?: number;
  maxReloads?: number;
  /** REQ-D010: cc's own click on the check. Without it the login only waits (the REQ-D007 wait). */
  clickCheck?: () => Promise<ClickResult>;
  /** REQ-D010: reload the sign-in page and fill the form again. */
  reload?: () => Promise<void>;
  /** REQ-D010: one step line per login for the job's run log. */
  onStep?: (line: string) => void;
  mode?: "headful" | "headless";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type HumanCheckOutcome = "none" | "auto-solved" | "passed-after-click" | "passed-after-reload";
export interface SubmitOutcome {
  submits: number;
  humanCheck: HumanCheck;
  waitedMs: number;
  clicks: number;
  clickMethods: string[];
  reloads: number;
  pageLoads: number;
  outcome: HumanCheckOutcome;
}

function where(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return "<unparseable url>"; }
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return "no"; }
}

/**
 * Get past the human check (REQ-D010), press Login when the check allows it (REQ-D007) and wait until the browser is
 * on grok.com. Throws a precise error naming every attempt when every automated attempt is used (at once) or when the
 * 10-minute bound passes. Every call reports one step line through onStep.
 */
export async function submitAndConfirmGrokLogin(page: LoginPage, submit: () => Promise<void>, opts: SubmitOpts = {}): Promise<SubmitOutcome> {
  const total = opts.totalWaitMs ?? GROK_LOGIN_TOTAL_WAIT_MS;
  const pollMs = Math.max(500, opts.pollMs ?? GROK_LOGIN_POLL_MS);
  const resubmitMs = opts.resubmitMs ?? GROK_LOGIN_RESUBMIT_MS;
  const maxSubmits = opts.maxSubmits ?? GROK_LOGIN_MAX_SUBMITS;
  const autoSolveMs = opts.autoSolveMs ?? GROK_TURNSTILE_AUTO_SOLVE_MS;
  const clickRetryMs = opts.clickRetryMs ?? GROK_TURNSTILE_CLICK_RETRY_MS;
  const maxClicks = opts.maxClicks ?? GROK_TURNSTILE_MAX_CLICKS;
  const maxReloads = opts.maxReloads ?? GROK_TURNSTILE_MAX_RELOADS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  let submits = 0, loadSubmits = 0, clicks = 0, loadClicks = 0, reloads = 0, pageLoads = 1;
  const clickMethods: string[] = [];
  let lastToken: string | undefined;
  let lastSubmitAt = -Infinity, lastClickAt = -Infinity;
  let pendingSince: number | undefined;
  let sawPending = false;
  let last: HumanCheck = "none";

  const attempts = () => `auto-solve wait ${Math.round(autoSolveMs / 1000)}s, clicked the check ${clicks} time(s) (methods: ${clickMethods.join(",") || "none"}), reloaded ${reloads} time(s) over ${pageLoads} page load(s)`;
  const step = (check: string, confirmed: string, error?: string) => {
    const line = `grok-login mode=${opts.mode ?? "headful"} human-check=${check} clicks=${clicks} click-methods=${clickMethods.join(",") || "none"} reloads=${reloads} page-loads=${pageLoads} login-presses=${submits} confirmed=${confirmed} waited-ms=${now() - started}${error ? ` error=${error}` : ""}`;
    try { opts.onStep?.(line); } catch { /* a report must never fail the login */ }
  };
  const fail = (msg: string, error: string): never => { step("failed", "no", error); throw new Error(msg); };

  for (;;) {
    if (grokLoginReached(page.url())) {
      const outcome: HumanCheckOutcome = !sawPending ? "none" : reloads > 0 ? "passed-after-reload" : clicks > 0 ? "passed-after-click" : "auto-solved";
      step(outcome, hostOf(page.url()));
      return { submits, humanCheck: last, waitedMs: now() - started, clicks, clickMethods: [...clickMethods], reloads, pageLoads, outcome };
    }
    const { state, token } = await humanCheckState(page);
    last = state;
    // the 10-minute bound comes before any action: nothing is clicked, reloaded or pressed after it
    if (now() - started >= total) {
      fail(`grok.com login did not reach grok.com within ${Math.round(total / 1000)}s: Login pressed ${submits} time(s); human check ${state}; attempts: ${attempts()}; page ${where(page.url())}`, "deadline");
    }
    if (state === "pending") {
      sawPending = true;
      if (pendingSince === undefined) pendingSince = now();
      if (opts.clickCheck) {
        const firstDue = loadClicks === 0 && now() - pendingSince >= autoSolveMs;
        const againDue = loadClicks > 0 && loadClicks < maxClicks && now() - lastClickAt >= clickRetryMs;
        const loadSpent = loadClicks >= maxClicks && now() - lastClickAt >= clickRetryMs;
        if (firstDue || againDue) {
          const r = await opts.clickCheck().catch(() => ({ clicked: false, method: "error" }) as { clicked: boolean; method: string });
          clicks++; loadClicks++; clickMethods.push(r.method); lastClickAt = now();
          await sleep(pollMs);
          continue;
        }
        if (loadSpent) {
          if (opts.reload && reloads < maxReloads) {
            reloads++;
            await opts.reload().then(() => { pageLoads++; }, () => undefined); // a reload that throws is counted; the next round goes on
            loadClicks = 0; loadSubmits = 0; pendingSince = undefined; lastToken = undefined; lastSubmitAt = -Infinity; lastClickAt = -Infinity;
            await sleep(pollMs);
            continue;
          }
          fail(`grok.com human check did not pass after every automated attempt: ${attempts()}; Login pressed ${submits} time(s); page ${where(page.url())}`, "human-check-exhausted");
        }
      }
    } else {
      pendingSince = undefined;
      const fresh = state === "passed" && token !== lastToken;
      const stale = now() - lastSubmitAt >= resubmitMs;
      if (loadSubmits < maxSubmits && (fresh || stale)) {
        await submit().catch(() => undefined); // a press that fails is retried on the next poll; the deadline bounds it
        submits++; loadSubmits++;
        lastToken = token;
        lastSubmitAt = now();
        await sleep(pollMs);
        continue;
      }
    }
    await sleep(pollMs);
  }
}
