// @reqs ACCT-C08 ACCT-C10 ACCT-C11
import fs from "node:fs";
import { chromium, type Browser, type Cookie, type Page } from "patchright";
import { AccountNotAuthorizedError, assertSameIdentity, expectedIdentity, registryIdentity, type ChoiceDeps, type SeenIdentity } from "../core/accountChoice.js";
import type { BrowserSession } from "./chrome.js";
import { launchChrome, loadAuthSpecs, masterDir, openSession, sessionHealthy, shutdownChrome } from "./chrome.js";
import { readPlatformAccount } from "./identity.js";
import { acquireLane } from "./lanes.js";
import { profileInUse, withMasterLock } from "./profile.js";

const LIFETIME_S = 30 * 24 * 3600;
const domainMatches = (d0: string, hosts: string[]) => { const d = d0.replace(/^\./, ""); return hosts.some((h) => d === h || d.endsWith("." + h)); };

export interface SeedReport { copied: Record<string, number>; signedIn: Record<string, boolean> }

/** The named account a seed copies for (accounts.json entry). */
export interface SeedAccount { id: string; email?: string; platforms: string[]; loginProvider?: Partial<Record<string, string>> }
export interface SeedOptions {
  account: SeedAccount;
  /** Connects to the source Chrome. Production: chromium.connectOverCDP on 127.0.0.1:<port>. */
  connect?: (port: number) => Promise<Browser>;
  /** Reads which account a platform shows signed in, on a page of the source browser. Production: data/selectors/identity.json. */
  readIdentity?: (platform: string, page: Page) => Promise<SeenIdentity>;
}

/**
 * ACCT-C08: every platform of the named account must show exactly that account signed in, in the source browser,
 * before any cookie is read. No email to compare with, an unreadable account, or another account refuses the seed.
 */
export async function verifySeedSource(account: SeedAccount, read: (platform: string) => Promise<SeenIdentity>, deps: ChoiceDeps = {}): Promise<void> {
  if (!account.email) throw new AccountNotAuthorizedError(`account ${account.id} has no email to verify the source browser against; nothing was copied`);
  if (!account.platforms.length) throw new AccountNotAuthorizedError(`account ${account.id} lists no platforms; nothing was copied`);
  for (const p of account.platforms) assertSameIdentity(p, await registryIdentity(p, expectedIdentity(account, p), deps), await read(p).catch(() => undefined)); // ACCT-C10 ACCT-C11
}

/**
 * One-time (and re-seed) setup of the COLD master: copy the platform sign-in cookies out of an already signed-in Chrome
 * (over CDP, in memory only: values are never printed, logged or written outside Chrome's own encrypted cookie store)
 * into the master profile, using a normally launched Chrome on the master itself. Reports counts per platform, never values.
 * ACCT-C08: only the named account's platforms are copied, and only after the source browser shows exactly that account
 * signed in on each of them (verifySeedSource); otherwise nothing is read, copied or written.
 */
export async function seedMaster(fromPort: number, master = masterDir(), o: SeedOptions): Promise<SeedReport> {
  if (!o?.account) throw new AccountNotAuthorizedError("no account was named for the seed; nothing was copied");
  if (profileInUse(master)) throw new Error(`master profile ${master} is in use by a running Chrome; seed needs a cold master`);
  const specs = Object.fromEntries(Object.entries(loadAuthSpecs()).filter(([p]) => o.account.platforms.includes(p)));
  const hosts = Object.values(specs).flatMap((s) => [...s.hosts, ...s.ssoHosts]);
  const read = o.readIdentity ?? ((p: string, page: Page) => readPlatformAccount(p, { page } as unknown as BrowserSession));
  const src = await (o.connect ?? ((port: number) => chromium.connectOverCDP(`http://127.0.0.1:${port}`)))(fromPort);
  let cookies: Cookie[];
  try {
    const ctx = src.contexts()[0];
    const page = await ctx.newPage();
    try { await verifySeedSource(o.account, (p) => read(p, page)); } finally { await page.close().catch(() => {}); }
    cookies = (await ctx.cookies()).filter((c) => domainMatches(c.domain, hosts));
  } finally { await src.close().catch(() => {}); }
  const now = Math.floor(Date.now() / 1000);
  const prepared = cookies.map((c) => ({ ...c, expires: c.expires > 0 ? c.expires : now + LIFETIME_S }));
  const lane = await acquireLane();
  fs.mkdirSync(master, { recursive: true });
  let launched: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    return await withMasterLock(master, async () => { // clones wait while the master is being written
      launched = await launchChrome(master, lane.port);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${lane.port}`);
      const ctx = browser.contexts()[0];
      await ctx.addCookies(prepared);
      const after = await ctx.cookies();
      const report: SeedReport = { copied: {}, signedIn: {} };
      for (const [p, s] of Object.entries(specs)) {
        report.copied[p] = prepared.filter((c) => domainMatches(c.domain, [...s.hosts, ...s.ssoHosts])).length;
        report.signedIn[p] = sessionHealthy(after, [p], specs);
      }
      await shutdownChrome(browser, launched.child, launched.exited);
      launched = undefined;
      return report;
    });
  } finally {
    if (launched) await shutdownChrome(browser, launched.child, launched.exited);
    lane.release();
  }
}

/** Read-only health check: clone the master into a throwaway lane, report which platforms still have a sign-in cookie, discard. */
export async function checkMaster(master?: string, platforms?: string[]): Promise<Record<string, boolean>> {
  const all = loadAuthSpecs();
  const specs = platforms ? Object.fromEntries(Object.entries(all).filter(([p]) => platforms.includes(p))) : all;
  const s = await openSession({ master });
  try {
    const cookies = await s.context.cookies();
    return Object.fromEntries(Object.keys(specs).map((p) => [p, sessionHealthy(cookies, [p], specs)]));
  } finally { await s.close(); }
}
