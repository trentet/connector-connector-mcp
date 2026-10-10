import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "patchright";
import { sleep } from "./dom.js";

/**
 * Drives Google's sign-in and OAuth consent screens for `cc reauth`, in a browser session cc already owns (cloned master profile, own lane).
 *
 * This is a deliberately bounded EXCEPTION to cc's rule of never clicking a consent/Approve button: it acts only
 *   - on a page whose host is Google's own (spec.googleHosts); on any other host it stops,
 *   - for a URL cc built itself from a registry-declared `googleOAuth` block (the operator's own OAuth client and declared scopes),
 *   - until the loopback redirect has delivered the authorization code (`isDone`), then it stops touching the page.
 * It never fills anything except the Google account's own email/password (vault credential, resolved in-process, never logged).
 * A 2-step-verification challenge it cannot pass is waited on for a bounded time and then reported, never guessed at.
 *
 * Every URL it logs is origin + path only (the query holds the client id and state).
 */
export interface ConsentSpec {
  emailInput: string; emailNext: string; passwordInput: string; passwordNext: string;
  nextText: string; advancedText: string; goToAppText: string; continueText: string; allowText: string; selectAllText: string;
  paths: { accountChooser: string; consent: string; challenge: string };
  accountChooserChrome: string; accountSwitcherChipAria: string; googleHosts: string[];
  limits: { maxSteps: number; settleMs: number; overallTimeoutMs: number; twoFaGraceMs: number; sameUrlStreak: number };
}
export interface GoogleCredential { username?: string; password?: string }

let cached: ConsentSpec | undefined;
export function loadConsentSpec(dir = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"))): ConsentSpec {
  if (cached && !process.env.CC_SELECTORS_DIR) return cached;
  const spec = JSON.parse(fs.readFileSync(path.join(dir, "google-consent.json"), "utf8")) as ConsentSpec;
  if (!process.env.CC_SELECTORS_DIR) cached = spec;
  return spec;
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const safeUrl = (u: string): string => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return "(unparseable url)"; } };
export function isGoogleHost(url: string, spec: Pick<ConsentSpec, "googleHosts">): boolean {
  try { const h = new URL(url).hostname; return spec.googleHosts.some((g) => h === g || h.endsWith("." + g)); } catch { return false; }
}

async function clickIfVisible(page: Page, selector: string): Promise<boolean> {
  const l = page.locator(selector).first();
  if ((await l.count()) === 0 || !(await l.isVisible().catch(() => false))) return false;
  await l.click({ timeout: 5000 }).catch(() => undefined);
  return true;
}
async function clickTextIfVisible(page: Page, text: RegExp): Promise<boolean> {
  const l = page.getByText(text, { exact: false }).first();
  if ((await l.count()) === 0 || !(await l.isVisible().catch(() => false))) return false;
  await l.click({ timeout: 5000 }).catch(() => undefined);
  return true;
}
/** Google's multi-scope consent summary appends a fresh Continue below the spent one without changing the URL: the live forward control is the bottom-most visible match. */
async function clickLastTextIfVisible(page: Page, text: RegExp): Promise<boolean> {
  const l = page.getByText(text, { exact: false });
  for (let i = (await l.count()) - 1; i >= 0; i--) {
    const el = l.nth(i);
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 5000 }).catch(() => undefined); return true; }
  }
  return false;
}
async function clickAndAwaitNavigation(page: Page, el: Locator, settleMs = 4000): Promise<void> {
  const before = page.url();
  await el.click({ timeout: 5000 }).catch(() => undefined);
  for (const end = Date.now() + settleMs; Date.now() < end && page.url() === before;) await sleep(200);
}

/** The account-chooser tile for OUR account (exact email match), else the first tile that is not page chrome. Excludes Google's account-switcher chip, which leads to a help page. */
async function clickAccountChooserEntry(page: Page, spec: ConsentSpec, ownEmail?: string): Promise<string | undefined> {
  const candidates = page.locator("button, a, div[role='link'], div[role='button'], li");
  const count = Math.min(await candidates.count(), 30);
  const chip = new RegExp(spec.accountSwitcherChipAria, "i");
  const chrome = new RegExp(spec.accountChooserChrome, "i");
  if (ownEmail) {
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      if (chip.test((await el.getAttribute("aria-label").catch(() => null)) ?? "")) continue;
      const text = ((await el.textContent().catch(() => "")) ?? "").trim();
      if (text.toLowerCase().includes(ownEmail.toLowerCase())) { await clickAndAwaitNavigation(page, el); return "clicked the account chooser entry for our own account"; }
    }
  }
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = ((await el.textContent().catch(() => "")) ?? "").trim();
    if (!text || EMAIL_RE.test(text) || chrome.test(text)) continue;
    await clickAndAwaitNavigation(page, el);
    return "clicked an account chooser entry";
  }
  return undefined;
}

/** Counts and the visible button labels of a consent screen, for the log (no field values, no URL query). */
async function describeConsent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const vis = (e: Element) => { const h = e as HTMLElement; return !!(h.offsetWidth || h.offsetHeight); };
    const boxes = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(vis);
    const checked = boxes.filter((b) => (b as HTMLInputElement).checked || b.getAttribute("aria-checked") === "true").length;
    const buttons = [...document.querySelectorAll("button, [role=button]")].filter(vis).map((b) => (b.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30)).filter(Boolean).slice(0, 8);
    return `${boxes.length} checkbox(es), ${checked} checked; buttons: ${buttons.join(" | ")}`;
  });
}

/** One "do whatever the next forward-progress thing on this screen is". Returns a label, or undefined when nothing recognized is there. */
export async function advanceOneStep(page: Page, cred: GoogleCredential, spec: ConsentSpec): Promise<string | undefined> {
  const email = page.locator(spec.emailInput).first();
  if ((await email.count()) > 0 && (await email.isVisible().catch(() => false))) {
    if (!cred.username) throw new Error("the Google account's vault entry has no username to enter at the email prompt");
    await email.fill(cred.username).catch(() => undefined);
    if (await clickIfVisible(page, spec.emailNext)) return "filled email, clicked Next";
    if (await clickTextIfVisible(page, new RegExp(spec.nextText))) return "filled email, clicked Next (by text)";
    await email.press("Enter", { timeout: 5000 }).catch(() => undefined);
    return "filled email, pressed Enter";
  }
  const pw = page.locator(spec.passwordInput).first();
  if ((await pw.count()) > 0 && (await pw.isVisible().catch(() => false))) {
    if (!cred.password) throw new Error("the Google account's vault entry has no password to enter at the password prompt");
    await pw.fill(cred.password).catch(() => undefined);
    if (await clickIfVisible(page, spec.passwordNext)) return "filled password, clicked Next";
    if (await clickTextIfVisible(page, new RegExp(spec.nextText))) return "filled password, clicked Next (by text)";
    await pw.press("Enter", { timeout: 5000 }).catch(() => undefined);
    return "filled password, pressed Enter";
  }
  if (page.url().includes(spec.paths.accountChooser)) {
    const chosen = await clickAccountChooserEntry(page, spec, cred.username);
    if (chosen) return chosen;
  }
  if (await clickTextIfVisible(page, new RegExp(spec.advancedText))) return "clicked Advanced (unverified-app notice)";
  if (await clickTextIfVisible(page, new RegExp(spec.goToAppText))) return "clicked Go to <app> (unsafe)";
  // A consent screen (the v2 summary or the newer v3 page) lists each requested scope with its own checkbox, UNCHECKED by default for an
  // app in Testing status; continuing with any left unchecked makes Google grant fewer scopes than asked (or redirect with error=access_denied).
  // Tick every visible unchecked box first, then continue.
  if (new RegExp(spec.paths.consent).test(new URL(page.url()).pathname)) {
    const boxes = page.locator('input[type="checkbox"], [role="checkbox"]');
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const cb = boxes.nth(i);
      if (!(await cb.isVisible().catch(() => false))) continue;
      const aria = await cb.getAttribute("aria-checked").catch(() => null);
      const checked = aria !== null ? aria === "true" : await cb.isChecked().catch(() => true);
      if (!checked) {
        if (aria !== null) await cb.click({ timeout: 5000 }).catch(() => undefined); else await cb.check({ timeout: 5000 }).catch(() => undefined);
        return `checked scope box ${i + 1}/${n}`;
      }
    }
  }
  if (await clickLastTextIfVisible(page, new RegExp(spec.continueText))) return "clicked Continue";
  if (await clickLastTextIfVisible(page, new RegExp(spec.allowText))) return "clicked Allow";
  if (await clickTextIfVisible(page, new RegExp(spec.selectAllText))) return "clicked Select all";
  return undefined;
}

export interface ConsentOptions {
  context: BrowserContext;
  /** The consent URL cc built (never logged). */
  url: string;
  credential: GoogleCredential;
  /** True once the loopback redirect has delivered the authorization code or an OAuth error. */
  isDone: () => boolean;
  /** Redacted log sink. */
  log: (line: string) => void;
  spec?: ConsentSpec;
}

/** Walks the screens until the loopback redirect fires. Resolves when done; throws with a safe message when it cannot get there. */
export async function driveConsent(o: ConsentOptions): Promise<void> {
  const spec = o.spec ?? loadConsentSpec();
  const L = spec.limits;
  const page = await o.context.newPage();
  const deadline = Date.now() + L.overallTimeoutMs;
  try {
    await page.goto(o.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(L.settleMs); // Google's sign-in is a JS-rendered SPA: nothing is visible right at domcontentloaded
    let streak = 0, retriedUrl: string | undefined;
    for (let i = 0; i < L.maxSteps && !o.isDone(); i++) {
      if (Date.now() > deadline) throw new Error(`consent did not finish within ${L.overallTimeoutMs / 1000}s (last page ${safeUrl(page.url())})`);
      const before = page.url();
      if (!isGoogleHost(before, spec)) { if (o.isDone()) break; throw new Error(`the browser left Google's own pages (now at ${safeUrl(before)}) before the redirect arrived; not acting on it`); }
      if (new RegExp(spec.paths.consent).test(safeUrl(before))) o.log(`step ${i + 1}: consent screen: ${await describeConsent(page).catch(() => "(could not describe)")}`);
      let action = await advanceOneStep(page, o.credential, spec);
      if (!action && retriedUrl !== before) { retriedUrl = before; await sleep(L.settleMs); action = await advanceOneStep(page, o.credential, spec); } // a fresh screen can still be rendering
      if (o.isDone()) { if (action) o.log(`step ${i + 1}: ${action} -> the redirect delivered the result`); break; }
      if (!action) {
        if (page.url().includes(spec.paths.challenge)) {
          o.log(`step ${i + 1}: Google asked for 2-step verification at ${safeUrl(page.url())}; waiting up to ${L.twoFaGraceMs / 1000}s for it to clear (a human must approve it on their phone)`);
          const end = Date.now() + L.twoFaGraceMs;
          let cleared = false;
          while (Date.now() < end) { await sleep(3000); if (o.isDone() || !page.url().includes(spec.paths.challenge)) { cleared = true; break; } }
          if (cleared) { o.log(`step ${i + 1}: verification cleared`); continue; }
          throw new Error("Google asked for 2-step verification that nobody approved in time; the manual fallback is the connector's own consent flow");
        }
        throw new Error(`no recognized forward control at ${safeUrl(page.url())} (unhandled screen: captcha, account problem or a new Google screen); fix data/selectors/google-consent.json`);
      }
      await sleep(L.settleMs);
      o.log(`step ${i + 1}: ${action} -> ${safeUrl(page.url())}`);
      if (o.isDone()) break;
      if (page.url() === before) { if (++streak >= L.sameUrlStreak) throw new Error(`${streak} actions in a row left the page unchanged at ${safeUrl(page.url())}; likely clicking a no-op`); } else streak = 0;
    }
    if (!o.isDone()) throw new Error(`never reached the redirect after ${L.maxSteps} steps (last page ${safeUrl(page.url())})`);
  } finally {
    await page.close().catch(() => undefined);
  }
}
