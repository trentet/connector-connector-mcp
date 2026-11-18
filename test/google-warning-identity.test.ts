// @reqs REQ-D012 ACCT-C06
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "patchright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driveConsent, googleIdentity, loadConsentSpec, type ConsentSpec } from "../src/browser/googleConsent.js";

/**
 * REQ-D012: Google's first page for the renewal is the unverified-app warning (/signin/oauth/warning). It carries no
 * [data-email] and no account chip; it names the signed-in account only in the data-third-party-email attribute of its
 * Continue button (read live on 18 Nov 2026 by a read-only probe). The next page (/signin/oauth/v3/consent) carries
 * [data-email]. This fake Google serves exactly that sequence, so the gap of the earlier fake (data-email on every page) is closed.
 */
function findChrome(): string | undefined {
  if (process.env.CC_TEST_CHROME) return process.env.CC_TEST_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  if (!dir) return undefined;
  return [`${root}/${dir}/chrome-linux/chrome`, `${root}/${dir}/chrome-win64/chrome.exe`, `${root}/${dir}/chrome-win/chrome.exe`].find((e) => fs.existsSync(e));
}
const browser: Browser | undefined = await chromium.launch({ headless: true, executablePath: findChrome() }).catch(() => undefined);

let server: http.Server, base = "";
let loopback: http.Server, loopbackBase = "";
let delivered: { code?: string; error?: string } = {};
let consentHits = 0;

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const u = new URL(req.url ?? "/", base);
  const redirect = u.searchParams.get("redirect_uri") ?? "", state = u.searchParams.get("state") ?? "";
  const who = u.searchParams.get("who") ?? "me@example.com";
  const carry = `redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}&who=${encodeURIComponent(who)}`;
  const send = (html: string) => { res.setHeader("content-type", "text/html"); res.end(page(html)); };
  if (u.pathname === "/o/oauth2/v2/auth") { res.statusCode = 302; res.setHeader("location", `/signin/oauth/warning?${carry}`); return void res.end(); }
  if (u.pathname === "/signin/oauth/warning") {
    // The live warning page: the account only in data-third-party-email on Continue (none when who=none); an email in plain text is not a marker.
    const attr = who === "none" ? "" : ` data-third-party-email="${who}"`;
    return send(`<h1>Google hasn't verified this app</h1><p>Contact: support@example.org</p><button${attr} onclick="location='/signin/oauth/v3/consent?${carry}'">Continue</button><button>Back to safety</button>`);
  }
  if (u.pathname === "/signin/oauth/v3/consent") {
    consentHits++;
    return send(`<div data-email="${who}"></div><div role="checkbox" aria-checked="false" id="s1" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked')==='true'?'false':'true')" style="width:20px;height:20px;border:1px solid #000"></div> Drive
      <button onclick="var ok=document.getElementById('s1').getAttribute('aria-checked')==='true'; location='${redirect}?'+(ok?'code=FIXTURECODE':'error=access_denied')+'&state=${encodeURIComponent(state)}'">Continue</button>`);
  }
  res.statusCode = 404; res.end("no");
}

beforeAll(async () => {
  server = http.createServer(route);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  loopback = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.searchParams.has("code") || u.searchParams.has("error")) delivered = { code: u.searchParams.get("code") ?? undefined, error: u.searchParams.get("error") ?? undefined };
    res.end("ok");
  });
  await new Promise<void>((r) => loopback.listen(0, "127.0.0.1", r));
  loopbackBase = `http://127.0.0.1:${(loopback.address() as AddressInfo).port}/`;
});
afterAll(async () => { server?.close(); loopback?.close(); await browser?.close(); });

const spec = (): ConsentSpec => ({ ...loadConsentSpec(), googleHosts: ["127.0.0.1"], limits: { ...loadConsentSpec().limits, settleMs: 60, overallTimeoutMs: 30_000, maxSteps: 12, twoFaGraceMs: 600 } });
const authUrl = (who?: string) => `${base}/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(loopbackBase)}&state=st-1${who ? `&who=${encodeURIComponent(who)}` : ""}`;
async function run(who?: string): Promise<{ err?: Error; lines: string[] }> {
  delivered = {}; consentHits = 0;
  const ctx = await browser!.newContext();
  const lines: string[] = [];
  try {
    await driveConsent({ context: ctx, url: authUrl(who), credential: { username: "me@example.com", password: "pw-FIXTURE" }, isDone: () => !!(delivered.code || delivered.error), log: (l) => lines.push(l), spec: spec() });
    return { lines };
  } catch (e) { return { err: e as Error, lines }; } finally { await ctx.close(); }
}

describe.skipIf(!browser)("REQ-D012 identity on Google's unverified-app warning page (real Chromium, fake Google)", { timeout: 40_000 }, () => {
  it("TC-D012-01 the warning page's data-third-party-email is read as the signed-in account", async () => {
    const ctx = await browser!.newContext();
    try {
      const p = await ctx.newPage();
      await p.goto(`${base}/signin/oauth/warning?who=me@example.com`);
      expect(await googleIdentity(p, spec())).toEqual(["me@example.com"]);
    } finally { await ctx.close(); }
  });

  it("TC-D012-02 Continue on the warning page is clicked for the specified account", async () => {
    const { err, lines } = await run();
    expect(err).toBeUndefined();
    expect(lines.some((l) => /clicked Continue -> .*\/signin\/oauth\/v3\/consent/.test(l))).toBe(true);
  });

  it("TC-D012-03 another account on the warning page refuses with ACCOUNT_MISMATCH and the consent page is never reached", async () => {
    const { err } = await run("someone-else@example.com");
    expect(String(err?.message)).toMatch(/^ACCOUNT_MISMATCH: /);
    expect(consentHits).toBe(0);
    expect(delivered.code).toBeUndefined();
  });

  it("TC-D012-04 a warning page with no account marker refuses with ACCOUNT_NOT_AUTHORIZED", async () => {
    const { err } = await run("none");
    expect(String(err?.message)).toMatch(/^ACCOUNT_NOT_AUTHORIZED: /);
    expect(consentHits).toBe(0);
  });

  it("TC-D012-05 markers are merged without duplicates and an email in page text is not identity", async () => {
    const ctx = await browser!.newContext();
    try {
      const p = await ctx.newPage();
      await p.setContent(`<div data-email="Me@Example.com"></div><button data-third-party-email="me@example.com">Continue</button><p>write to other@example.org</p><script>var x = "script@example.org";</script>`);
      expect(await googleIdentity(p, spec())).toEqual(["me@example.com"]);
      await p.setContent(`<button data-third-party-email="a@example.com">Continue</button><div data-email="b@example.com"></div>`);
      expect([...(await googleIdentity(p, spec()))].sort()).toEqual(["a@example.com", "b@example.com"]);
    } finally { await ctx.close(); }
  });

  it("TC-D012-06 warning page then consent page then redirect completes and delivers the code", async () => {
    const { err } = await run();
    expect(err).toBeUndefined();
    expect(delivered.code).toBe("FIXTURECODE");
    expect(consentHits).toBe(1);
  });
});