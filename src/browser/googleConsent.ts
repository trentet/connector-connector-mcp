import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "patchright";
import { sleep } from "./dom.js";
import { assertSameAccount } from "../core/accountChoice.js";

/**
 * Drives Google's sign-in and OAuth consent screens for `cc reauth`, in a browser session cc already owns (cloned master profile, own lane).
 *
 * This is a deliberately bounded EXCEPTION to cc's rule of never clicking a consent/Approve button: it acts only
 *   - on a page whose host is Google's own (spec.googleHosts); on any other host it stops,
 *   - for a URL cc built itself from a registry-declared `googleOAuth` block (the operator's own OAuth client and declared scopes),
 *   - until the loopback redirect has delivered the authorization code (`isDone`), then it stops touching the page.
 * It never fills anything except the Google account's own email/password and, when its registry entry says the vault holds one, the current authenticator code (vault credential, resolved in-process, never logged).
 * A 2-step-verification challenge it cannot pass is waited on for a bounded time and then reported, never guessed at.
 *
 * Every URL it logs is origin + path only (the query holds the client id and state).
 *
 * The second, narrower use is `cc browser signin` (signin.ts, operator 2026-10-19): signing a registry-declared account in to claude.ai with Google.
 * There `advanceOneStep` runs in "signin" mode: email, password, authenticator code, the account-chooser tile whose text holds THAT account's
 * email (never any other tile) and Google's "Continue" to the site. It never ticks a box, never clicks Allow, Advanced or "Go to (unsafe)".
 */
export interface ConsentSpec {
  emailInput: string; emailNext: string; passwordInput: string; passwordNext: string; totpInput: string; totpNext: string;
  nextText: string; advancedText: string; goToAppText: string; continueText: string; allowText: string; selectAllText: string;
  paths: { accountChooser: string; consent: string; challenge: string; totpChallenge: string };
  accountChooserChrome: string; accountSwitcherChipAria: string; googleHosts: string[];
  limits: { maxSteps: number; settleMs: number; overallTimeoutMs: number; twoFaGraceMs: number; sameUrlStreak: number };
}
/** `totp` is fetched lazily, at the moment Google asks for the code (a code lives about 30 s); never logged. */
export interface GoogleCredential { username?: string; password?: string; totp?: () => Promise<string | undefined> }

let cached: ConsentSpec | undefined;
export function loadConsentSpec(dir = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"))): ConsentSpec {
  if (cached && !process.env.CC_SELECTORS_DIR) return cached;
  const spec = JSON.parse(fs.readFileSync(path.join(dir, "google-consent.json"), "utf8")) as ConsentSpec;
  if (!process.env.CC_SELECTORS_DIR) cached = spec;
  return spec;
}

const EMAILS_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
const safeUrl = (u: string): string => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return "(unparseable url)"; } };
export function isGoogleHost(url: string, spec: Pick<ConsentSpec, "googleHosts">): boolean {
  try { const h = new URL(url).hostname; return spec.googleHosts.some((g) => h === g || h.endsWith("." + g)); } catch { return false; }
}

/** `before` runs after the control is found and before it is clicked; it throws to refuse the click (ACCT-C06). */
type Guard = () => Promise<void>;
async function clickIfVisible(page: Page, selector: string, before?: Guard): Promise<boolean> {
  const l = page.locator(selector).first();
  if ((await l.count()) === 0 || !(await l.isVisible().catch(() => false))) return false;
  await before?.();
  await l.click({ timeout: 5000 }).catch(() => undefined);
  return true;
}
async function clickTextIfVisible(page: Page, text: RegExp, before?: Guard): Promise<boolean> {
  const l = page.getByText(text, { exact: false }).first();
  if ((await l.count()) === 0 || !(await l.isVisible().catch(() => false))) return false;
  await before?.();
  await l.click({ timeout: 5000 }).catch(() => undefined);
  return true;
}
/** Google's multi-scope consent summary appends a fresh Continue below the spent one without changing the URL: the live forward control is the bottom-most visible match. */
async function clickLastTextIfVisible(page: Page, text: RegExp, before?: Guard): Promise<boolean> {
  const l = page.getByText(text, { exact: false });
  for (let i = (await l.count()) - 1; i >= 0; i--) {
    const el = l.nth(i);
    if (await el.isVisible().catch(() => false)) { await before?.(); await el.click({ timeout: 5000 }).catch(() => undefined); return true; }
  }
  return false;
}
async function clickAndAwaitNavigation(page: Page, el: Locator, settleMs = 4000): Promise<void> {
  const before = page.url();
  await el.click({ timeout: 5000 }).catch(() => undefined);
  for (const end = Date.now() + settleMs; Date.now() < end && page.url() === before;) await sleep(200);
}

/**
 * The account-chooser tile for OUR account only: the element whose text names our email and no other email (ACCT-C03).
 * No other tile is ever clicked; without our account on the chooser this returns undefined. Excludes Google's
 * account-switcher chip, which leads to a help page.
 */
export async function clickAccountChooserEntry(page: Page, spec: ConsentSpec, ownEmail?: string): Promise<string | undefined> {
  if (!ownEmail) return undefined;
  const own = ownEmail.trim().toLowerCase();
  const candidates = page.locator("button, a, div[role='link'], div[role='button'], li");
  const count = Math.min(await candidates.count(), 30);
  const chip = new RegExp(spec.accountSwitcherChipAria, "i");
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (chip.test((await el.getAttribute("aria-label").catch(() => null)) ?? "")) continue;
    const text = ((await el.textContent().catch(() => "")) ?? "").trim().toLowerCase();
    const emails = new Set(text.match(EMAILS_RE) ?? []);
    if (emails.size === 1 && emails.has(own)) { await clickAndAwaitNavigation(page, el); return "clicked the account chooser entry for our own account"; }
  }
  return undefined;
}

/**
 * Every account a Google page shows as signed in: [data-email] values and the account chip's aria-label
 * (spec.accountSwitcherChipAria). Email text elsewhere on the page is not identity. ACCT-C06; not yet checked against
 * live Google, so a screen without these markers is refused (fail-closed).
 */
export async function googleIdentity(page: Page, spec: ConsentSpec): Promise<string[]> {
  const raw = await page.evaluate((chip) => {
    const re = new RegExp(chip, "i");
    const out: string[] = [];
    document.querySelectorAll("[data-email]").forEach((e) => { out.push(e.getAttribute("data-email") ?? ""); });
    document.querySelectorAll("[aria-label]").forEach((e) => { const a = e.getAttribute("aria-label") ?? ""; if (re.test(a)) out.push(a); });
    return out;
  }, spec.accountSwitcherChipAria).catch(() => [] as string[]);
  return [...new Set(raw.flatMap((s) => s.toLowerCase().match(EMAILS_RE) ?? []))];
}

/** ACCT-003 ACCT-C06: the Google page shows exactly our account as signed in; otherwise ACCOUNT_MISMATCH / ACCOUNT_NOT_AUTHORIZED. */
export async function assertGoogleAccount(page: Page, spec: ConsentSpec, ownEmail?: string): Promise<void> {
  assertSameAccount("Google", ownEmail, await googleIdentity(page, spec));
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
/** "consent" (cc reauth) may tick scope boxes and click Allow/Advanced; "signin" (cc browser signin) only signs our own account in and clicks Continue. */
export type StepMode = "consent" | "signin";

export async function advanceOneStep(page: Page, cred: GoogleCredential, spec: ConsentSpec, mode: StepMode = "consent"): Promise<string | undefined> {
  // ACCT-C06: entering our own email, password and code signs in the specified account; every other click or consent
  // below waits until the page shows that exact account as signed in (the chooser clicks only our own tile, ACCT-C03).
  const guard: Guard = () => assertGoogleAccount(page, spec, cred.username);
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
  const totpBox = page.locator(spec.totpInput).first();
  if (page.url().includes(spec.paths.totpChallenge) && (await totpBox.count()) > 0 && (await totpBox.isVisible().catch(() => false))) {
    if (!cred.totp) return undefined; // no authenticator secret configured for this account: the caller waits, then reports the challenge
    const code = await cred.totp();
    if (!code) throw new Error("Google asked for an authenticator code but the vault entry produced none (no TOTP field, or the vault refused)");
    await totpBox.fill(code).catch(() => undefined);
    if (await clickIfVisible(page, spec.totpNext)) return "entered the authenticator code, clicked Next";
    if (await clickTextIfVisible(page, new RegExp(spec.nextText))) return "entered the authenticator code, clicked Next (by text)";
    await totpBox.press("Enter", { timeout: 5000 }).catch(() => undefined);
    return "entered the authenticator code, pressed Enter";
  }
  if (page.url().includes(spec.paths.accountChooser)) {
    const chosen = await clickAccountChooserEntry(page, spec, cred.username);
    if (chosen) return chosen;
  }
  if (mode === "signin") return (await clickLastTextIfVisible(page, new RegExp(spec.continueText), guard)) ? "clicked Continue" : undefined;
  if (await clickTextIfVisible(page, new RegExp(spec.advancedText), guard)) return "clicked Advanced (unverified-app notice)";
  if (await clickTextIfVisible(page, new RegExp(spec.goToAppText), guard)) return "clicked Go to <app> (unsafe)";
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
        await guard();
        if (aria !== null) await cb.click({ timeout: 5000 }).catch(() => undefined); else await cb.check({ timeout: 5000 }).catch(() => undefined);
        return `checked scope box ${i + 1}/${n}`;
      }
    }
  }
  if (await clickLastTextIfVisible(page, new RegExp(spec.continueText), guard)) return "clicked Continue";
  if (await clickLastTextIfVisible(page, new RegExp(spec.allowText), guard)) return "clicked Allow";
  if (await clickTextIfVisible(page, new RegExp(spec.selectAllText), guard)) return "clicked Select all";
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
