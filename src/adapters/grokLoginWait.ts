// @reqs REQ-D004
/**
 * After the grok.com email-and-password form is submitted, a Cloudflare Turnstile may appear.
 * In a visible (headful) Chrome the challenge often auto-solves; if it does not, cc clicks the
 * Turnstile checkbox once, then waits up to 10 minutes for the redirect so a human at that
 * machine can finish the challenge in the same window.
 */

export const GROK_LOGIN_AUTO_WAIT_MS = 15_000;
export const GROK_LOGIN_TOTAL_WAIT_MS = 10 * 60_000;
export const GROK_LOGIN_REDIRECT = /accounts\.x\.ai\/account|grok\.com/;

export interface LoginPage {
  url(): string;
  waitForURL(pattern: RegExp, opts: { timeout: number }): Promise<void>;
  locator(selector: string): { first(): { count(): Promise<number>; click(opts?: { timeout?: number }): Promise<void> } };
  frames(): Array<{ url(): string; locator(selector: string): { first(): { count(): Promise<number>; click(opts?: { timeout?: number }): Promise<void> } } }>;
}

export function turnstilePresent(page: LoginPage): boolean {
  if (page.frames().some((f) => /challenges\.cloudflare\.com|turnstile/i.test(f.url()))) return true;
  return false;
}

export async function iframeTurnstilePresent(page: LoginPage): Promise<boolean> {
  if (turnstilePresent(page)) return true;
  try {
    return (await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').first().count()) > 0;
  } catch { return false; }
}

/** Click the Turnstile widget once. Failures are swallowed: a human may still complete it in the same window. */
export async function clickTurnstileOnce(page: LoginPage): Promise<boolean> {
  const iframe = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').first();
  try {
    if ((await iframe.count()) > 0) {
      await iframe.click({ timeout: 5000 });
      return true;
    }
  } catch { /* fall through to a frame checkbox */ }
  for (const frame of page.frames()) {
    if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
    try {
      const box = frame.locator('input[type="checkbox"], [role="checkbox"], body').first();
      if ((await box.count()) > 0) {
        await box.click({ timeout: 5000 });
        return true;
      }
    } catch { /* one attempt only */ }
    break;
  }
  return false;
}

export interface RedirectOpts {
  autoWaitMs?: number;
  totalWaitMs?: number;
  now?: () => number;
}

/**
 * Wait for the post-login redirect. First give a visible Chrome a short window to auto-solve
 * Turnstile. If the challenge is still up, click it once, then wait out the remaining 10 minutes.
 */
export async function waitForGrokLoginRedirect(page: LoginPage, opts: RedirectOpts = {}): Promise<void> {
  const autoWaitMs = opts.autoWaitMs ?? GROK_LOGIN_AUTO_WAIT_MS;
  const totalWaitMs = opts.totalWaitMs ?? GROK_LOGIN_TOTAL_WAIT_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const remaining = () => Math.max(1, totalWaitMs - (now() - started));

  const reached = await page.waitForURL(GROK_LOGIN_REDIRECT, { timeout: Math.min(autoWaitMs, totalWaitMs) }).then(() => true).catch(() => false);
  if (reached) return;
  if (await iframeTurnstilePresent(page)) await clickTurnstileOnce(page);
  await page.waitForURL(GROK_LOGIN_REDIRECT, { timeout: remaining() });
}
