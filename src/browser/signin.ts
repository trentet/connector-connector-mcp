import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import type { AccountDef } from "../core/accounts.js";
import { getCredential, getTotp, waitForCredential, type VaultCredential } from "../core/vaultClient.js";
import { launchChrome, loadAuthSpecs, sessionHealthy, shutdownChrome } from "./chrome.js";
import { sleep } from "./dom.js";
import { advanceOneStep, isGoogleHost, loadConsentSpec, type ConsentSpec, type GoogleCredential } from "./googleConsent.js";
import { acquireLane } from "./lanes.js";
import { profileInUse, withMasterLock } from "./profile.js";

/**
 * `cc browser signin`: sign one registry-declared account in to claude.ai with Google, straight into that account's cold master profile.
 * The password comes from the account's vault entry (resolved in-process, never printed or logged). Bounded like `cc reauth` (operator, 2026-10-19):
 * on claude.ai it clicks only "Continue with Google"; on Google's own hosts it only signs THAT account in (googleConsent.ts "signin" mode); it stops
 * as soon as claude.ai has its session cookie, and it refuses to keep a sign-in whose email is not the account's.
 */
export interface SignInSpec { url: string; continueWithGoogle: string; accountUrl: string; accountEmailField: string; timeoutMs: number; settleMs: number }
export function loadSignInSpec(dir = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"))): SignInSpec {
  return (JSON.parse(fs.readFileSync(path.join(dir, "claude.json"), "utf8")) as { signIn: SignInSpec }).signIn;
}

export interface SignInResult { status: "signed-in" | "already-signed-in"; email?: string; confirmed: boolean; steps: string[] }
const safeUrl = (u: string): string => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return "(unparseable url)"; } };
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
const pick = (o: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

/** The email claude.ai says is signed in, or undefined when the endpoint gives none. */
async function signedInEmail(page: Page, spec: SignInSpec): Promise<string | undefined> {
  const body = await page.evaluate(async (u) => { try { const r = await fetch(u, { credentials: "include" }); return r.ok ? await r.json() : null; } catch { return null; } }, spec.accountUrl).catch(() => null);
  const e = pick(body, spec.accountEmailField);
  return typeof e === "string" ? e : undefined;
}

export interface DriveSignInOptions {
  context: BrowserContext;
  credential: GoogleCredential;
  /** The account's email; a different signed-in email is an error. */
  email?: string;
  /** True once claude.ai holds its session cookie. */
  hasSession: () => Promise<boolean>;
  spec?: SignInSpec;
  google?: ConsentSpec;
  log?: (line: string) => void;
}

/** Drives claude.ai's login page and Google's sign-in in `context` until claude.ai has a session. Testable against fake hosts. */
export async function driveSignIn(o: DriveSignInOptions): Promise<SignInResult> {
  const spec = o.spec ?? loadSignInSpec(), g = o.google ?? loadConsentSpec();
  const steps: string[] = [];
  const log = (l: string) => { steps.push(l); o.log?.(l); };
  const page = await o.context.newPage();
  const loginHost = hostOf(spec.url);
  try {
    const confirm = async (status: SignInResult["status"]): Promise<SignInResult> => {
      if (hostOf(page.url()) !== loginHost) await page.goto(spec.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      const email = await signedInEmail(page, spec);
      if (email && o.email && email.toLowerCase() !== o.email.toLowerCase()) {
        await o.context.clearCookies({ domain: loginHost }).catch(() => undefined);
        throw new Error(`claude.ai signed in as a different account than ${o.email}; its sign-in was removed from this profile`);
      }
      return { status, email, confirmed: !!email, steps };
    };
    if (await o.hasSession()) return await confirm("already-signed-in");
    await page.goto(spec.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await sleep(spec.settleMs);
    const btn = page.getByRole("button", { name: new RegExp(spec.continueWithGoogle, "i") }).first();
    if ((await btn.count()) === 0) throw new Error(`no "${spec.continueWithGoogle}" button on ${safeUrl(page.url())}; fix data/selectors/claude.json signIn`);
    await btn.click({ timeout: 10000 });
    log(`clicked "${spec.continueWithGoogle}" on ${safeUrl(page.url())}`);
    const deadline = Date.now() + spec.timeoutMs;
    let streak = 0, last = "";
    for (let i = 0; i < g.limits.maxSteps * 2; i++) {
      if (await o.hasSession()) return await confirm("signed-in");
      if (Date.now() > deadline) throw new Error(`sign-in did not finish within ${spec.timeoutMs / 1000}s`);
      const gp = [page, ...o.context.pages()].find((p) => !p.isClosed() && isGoogleHost(p.url(), g)); // the same tab after a redirect, or a popup
      if (!gp) { await sleep(g.limits.settleMs); continue; } // between pages, or back on claude.ai waiting for the cookie
      const action = await advanceOneStep(gp, o.credential, g, "signin");
      if (!action) {
        if (gp.url().includes(g.paths.challenge)) {
          log(`Google asked for 2-step verification at ${safeUrl(gp.url())}; waiting up to ${g.limits.twoFaGraceMs / 1000}s for someone to approve it on the phone`);
          const end = Date.now() + g.limits.twoFaGraceMs;
          while (Date.now() < end && !gp.isClosed() && gp.url().includes(g.paths.challenge) && !(await o.hasSession())) await sleep(3000);
          if (!gp.isClosed() && gp.url().includes(g.paths.challenge) && !(await o.hasSession())) throw new Error("Google asked for 2-step verification that nobody approved in time; run the sign-in again and approve it on the phone");
          continue;
        }
        await sleep(g.limits.settleMs);
        if (++streak >= g.limits.sameUrlStreak) throw new Error(`no recognized sign-in control at ${safeUrl(gp.url())} (captcha, account problem or a new Google screen); fix data/selectors/google-consent.json`);
        continue;
      }
      const at = safeUrl(gp.url());
      streak = at === last ? streak + 1 : 0; last = at;
      if (streak >= g.limits.sameUrlStreak) throw new Error(`${streak} actions in a row left ${at} unchanged`);
      await sleep(g.limits.settleMs);
      log(`${action} (${at})`);
    }
    throw new Error("sign-in never reached claude.ai");
  } finally { await page.close().catch(() => undefined); }
}

export interface SignInDeps { vault?: (label: string) => Promise<VaultCredential | undefined>; waitForVault?: (label: string, ms: number) => Promise<VaultCredential | undefined>; totp?: (label: string) => Promise<string | undefined> }

/** The account's vault credential: waits up to `waitMs` for the entry when it is missing, and refuses one whose username is another email. */
export async function accountCredential(acc: AccountDef, waitMs: number, deps: SignInDeps = {}, log: (l: string) => void = () => {}): Promise<GoogleCredential> {
  const g = acc.signIn?.google;
  if (!g) throw new Error(`account "${acc.id}" has no signIn.google entry in registry/accounts.json`);
  let cred = await (deps.vault ?? getCredential)(g.vaultLabel);
  if (!cred?.password && waitMs > 0) {
    log(`vault entry "${g.vaultLabel}" not found yet; waiting up to ${Math.round(waitMs / 60000)} min for it (username = ${acc.email ?? "the account's email"}, password = its Google password)`);
    cred = await (deps.waitForVault ?? ((l, ms) => waitForCredential(l, ms)))(g.vaultLabel, waitMs);
  }
  if (!cred?.password) throw new Error(`vault entry "${g.vaultLabel}" has no password; add it to the vault and run the sign-in again`);
  if (cred.username && acc.email && cred.username.toLowerCase() !== acc.email.toLowerCase()) throw new Error(`vault entry "${g.vaultLabel}" is for a different email than account "${acc.id}"; not signing in`);
  const out: GoogleCredential = { username: cred.username ?? acc.email, password: cred.password };
  if (g.totp) out.totp = () => (deps.totp ?? getTotp)(g.vaultLabel);
  return out;
}

/** Sign `acc` in to claude.ai inside its own master profile (cold, under the master lock, on a lane like every other cc browser). */
export async function signInAccount(acc: AccountDef, master: string, opts: { waitForVaultMs?: number; log?: (l: string) => void } = {}): Promise<SignInResult> {
  if (!acc.platforms.includes("claude")) throw new Error(`account "${acc.id}" is not used on claude`);
  const log = opts.log ?? (() => {});
  const credential = await accountCredential(acc, opts.waitForVaultMs ?? 0, {}, log); // before any lock: waiting for the vault must not block other runs
  if (profileInUse(master)) throw new Error(`master profile ${master} is in use by a running Chrome; sign-in needs a cold master`);
  const specs = loadAuthSpecs();
  const lane = await acquireLane();
  fs.mkdirSync(master, { recursive: true });
  let launched: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    return await withMasterLock(master, async () => {
      launched = await launchChrome(master, lane.port);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${lane.port}`);
      const context = browser.contexts()[0];
      const res = await driveSignIn({ context, credential, email: acc.email, hasSession: async () => sessionHealthy(await context.cookies(), ["claude"], specs), log });
      await shutdownChrome(browser, launched.child, launched.exited);
      launched = undefined;
      return res;
    });
  } finally {
    if (launched) await shutdownChrome(browser, launched.child, launched.exited);
    lane.release();
  }
}
