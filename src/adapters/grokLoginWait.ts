// @reqs REQ-D004 REQ-D007
/**
 * The grok.com email-and-password login: press Login only once the human check (Cloudflare Turnstile) has passed,
 * then confirm the browser reached grok.com (REQ-D007). The runner then reads the signed-in account and its login
 * method and refuses to act unless they are exactly the run's account with an email login (ACCT-C05, ACCT-C10).
 *
 * cc never touches the human check itself (RULE-212, R-188.4): it does not click the widget or its checkbox. In the
 * visible (headful) Chrome the check usually passes on its own. Its state is read from Turnstile's own form field
 * (input[name="cf-turnstile-response"]: empty while pending, a token once passed). The 2026-11-15 failure was a
 * Login pressed while the check was still pending: the form did not submit, the check then passed, and nothing pressed
 * Login again, so the run waited ten minutes on a filled-in form. Now Login is pressed when the check has passed, and
 * pressed again (bounded) when a new pass token appears after a press that did not leave the page.
 */

export const GROK_LOGIN_TOTAL_WAIT_MS = 10 * 60_000;
/** Poll interval; cc never busy-waits (500 ms or slower). */
export const GROK_LOGIN_POLL_MS = 1000;
/** With no human check on the page, a press that has not left the page after this long is repeated. */
export const GROK_LOGIN_RESUBMIT_MS = 20_000;
export const GROK_LOGIN_MAX_SUBMITS = 4;
export const TURNSTILE_TOKEN_INPUT = 'input[name="cf-turnstile-response"]';
export const TURNSTILE_FRAME = /challenges\.cloudflare\.com|turnstile/i;

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

/** Read the human check's state from the page, without touching it. */
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

export interface SubmitOpts {
  totalWaitMs?: number;
  pollMs?: number;
  resubmitMs?: number;
  maxSubmits?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SubmitOutcome { submits: number; humanCheck: HumanCheck; waitedMs: number }

function where(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return "<unparseable url>"; }
}

/**
 * Press Login when the human check allows it and wait until the browser is on grok.com. Throws a precise error when it
 * does not get there in time: how many times Login was pressed, the human check's last state, and the page (origin and
 * path only). A check still pending at the deadline is reported as such (RULE-212 R-212.4: it did not pass in the
 * visible window); it is never clicked.
 */
export async function submitAndConfirmGrokLogin(page: LoginPage, submit: () => Promise<void>, opts: SubmitOpts = {}): Promise<SubmitOutcome> {
  const total = opts.totalWaitMs ?? GROK_LOGIN_TOTAL_WAIT_MS;
  const pollMs = Math.max(500, opts.pollMs ?? GROK_LOGIN_POLL_MS);
  const resubmitMs = opts.resubmitMs ?? GROK_LOGIN_RESUBMIT_MS;
  const maxSubmits = opts.maxSubmits ?? GROK_LOGIN_MAX_SUBMITS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  let submits = 0;
  let lastToken: string | undefined;
  let lastSubmitAt = -Infinity;
  let last: HumanCheck = "none";
  for (;;) {
    if (grokLoginReached(page.url())) return { submits, humanCheck: last, waitedMs: now() - started };
    const { state, token } = await humanCheckState(page);
    last = state;
    const fresh = state === "passed" && token !== lastToken;
    const stale = (state === "none" || state === "passed") && now() - lastSubmitAt >= resubmitMs;
    if (submits < maxSubmits && (fresh || stale)) {
      await submit().catch(() => undefined); // a press that fails is retried on the next poll; the deadline bounds it
      submits++;
      lastToken = token;
      lastSubmitAt = now();
      await sleep(pollMs);
      continue;
    }
    if (now() - started >= total) {
      const check = state === "pending" ? "pending (it did not pass in the visible window; cc never clicks it)" : state;
      throw new Error(`grok.com login did not reach grok.com within ${Math.round(total / 1000)}s: Login pressed ${submits} time(s); human check ${check}; page ${where(page.url())}`);
    }
    await sleep(pollMs);
  }
}
