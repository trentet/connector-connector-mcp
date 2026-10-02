import fs from "node:fs";
import path from "node:path";
import { chromium, type Cookie } from "patchright";
import { launchChrome, loadAuthSpecs, masterDir, openSession, sessionHealthy, shutdownChrome } from "./chrome.js";
import { acquireLane } from "./lanes.js";
import { profileInUse, readGeneration, withMasterLock } from "./profile.js";

const LIFETIME_S = 30 * 24 * 3600;
const domainMatches = (d0: string, hosts: string[]) => { const d = d0.replace(/^\./, ""); return hosts.some((h) => d === h || d.endsWith("." + h)); };

export interface SeedReport { copied: Record<string, number>; signedIn: Record<string, boolean> }

/**
 * One-time (and re-seed) setup of the COLD master: copy the platform sign-in cookies out of an already signed-in Chrome
 * (over CDP, in memory only: values are never printed, logged or written outside Chrome's own encrypted cookie store)
 * into the master profile, using a normally launched Chrome on the master itself. Reports counts per platform, never values.
 */
export async function seedMaster(fromPort: number): Promise<SeedReport> {
  const master = masterDir();
  if (profileInUse(master)) throw new Error(`master profile ${master} is in use by a running Chrome; seed needs a cold master`);
  const specs = loadAuthSpecs();
  const hosts = Object.values(specs).flatMap((s) => [...s.hosts, ...s.ssoHosts]);
  const src = await chromium.connectOverCDP(`http://127.0.0.1:${fromPort}`);
  let cookies: Cookie[];
  try { cookies = (await src.contexts()[0].cookies()).filter((c) => domainMatches(c.domain, hosts)); } finally { await src.close().catch(() => {}); }
  const now = Math.floor(Date.now() / 1000);
  const prepared = cookies.map((c) => ({ ...c, expires: c.expires > 0 ? c.expires : now + LIFETIME_S }));
  const lane = await acquireLane();
  fs.mkdirSync(master, { recursive: true });
  let launched: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
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
    return report;
  } finally {
    if (launched) await shutdownChrome(browser, launched.child, launched.exited);
    lane.release();
    await withMasterLock(master, () => fs.writeFileSync(path.join(master, "cc-generation"), String(readGeneration(master) + 1))).catch(() => {});
  }
}

/** Read-only health check: clone the master into a throwaway lane, report which platforms still have a sign-in cookie, discard. */
export async function checkMaster(): Promise<Record<string, boolean>> {
  const specs = loadAuthSpecs();
  const s = await openSession();
  try {
    const cookies = await s.context.cookies();
    return Object.fromEntries(Object.keys(specs).map((p) => [p, sessionHealthy(cookies, [p], specs)]));
  } finally { await s.close(); }
}
