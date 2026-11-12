// @reqs ACCT-C06
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "patchright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driveConsent, isGoogleHost, loadConsentSpec, type ConsentSpec } from "../src/browser/googleConsent.js";

/**
 * Real Chromium against a fake "Google" served from 127.0.0.1: the same screen sequence the live flow meets
 * (email -> password -> consent summary with one UNCHECKED box per scope -> Continue -> redirect carrying the code),
 * plus the places it must stop (a challenge nobody approves, an unknown screen, a redirect off Google's own hosts).
 * Skipped when no Chromium can be launched on this machine.
 */
/** CC_TEST_CHROME, else the Playwright Chromium under PLAYWRIGHT_BROWSERS_PATH when there is one, else patchright's own default. */
function findChrome(): string | undefined {
  if (process.env.CC_TEST_CHROME) return process.env.CC_TEST_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  if (!dir) return undefined;
  return [`${root}/${dir}/chrome-linux/chrome`, `${root}/${dir}/chrome-win64/chrome.exe`, `${root}/${dir}/chrome-win/chrome.exe`].find((e) => fs.existsSync(e));
}
const browser: Browser | undefined = await chromium.launch({ headless: true, executablePath: findChrome() }).catch(() => undefined);

const PASSWORD = "pw-FIXTURE-google-5555";
let server: http.Server, base = "";
let loopback: http.Server, loopbackBase = "";
let delivered: { code?: string; error?: string; state?: string } = {};

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const u = new URL(req.url ?? "/", base);
  const redirect = u.searchParams.get("redirect_uri") ?? "", state = u.searchParams.get("state") ?? "";
  const send = (html: string) => { res.setHeader("content-type", "text/html"); res.end(page(html)); };
  // ACCT-C06: the account Google shows as signed in (?who=, default our own; "none" shows none).
  const whoParam = u.searchParams.get("who");
  const carry = `redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}${whoParam ? `&who=${encodeURIComponent(whoParam)}` : ""}`;
  const who = whoParam ?? "me@example.com";
  const chip = who === "none" ? "" : `<div data-email="${who}"></div>`;
  if (u.pathname === "/o/oauth2/v2/auth") return send(`<input id="identifierId" type="email"><button id="identifierNext" onclick="location='/pw?${carry}'">Next</button>`);
  if (u.pathname === "/pw") return send(`<input type="password" name="Passwd"><button id="passwordNext" onclick="location='/signin/oauth/v2/consentsummary?${carry}'">Next</button>`);
  if (u.pathname === "/signin/oauth/v2/consentsummary") {
    return send(`${chip}<label><input type="checkbox" id="a"> Drive</label><label><input type="checkbox" id="b"> Docs</label>
      <button onclick="var ok=document.getElementById('a').checked&&document.getElementById('b').checked; location='${redirect}?'+(ok?'code=FIXTURECODE':'error=access_denied')+'&state=${encodeURIComponent(state)}'">Continue</button>`);
  }
  if (u.pathname === "/signin/oauth/v3/consent") {
    // Google's newer consent page: ARIA checkboxes (not <input>), one per scope, unchecked by default.
    return send(`${chip}<div role="checkbox" aria-checked="false" id="s1" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked')==='true'?'false':'true')" style="width:20px;height:20px;border:1px solid #000"></div> Drive
      <div role="checkbox" aria-checked="false" id="s2" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked')==='true'?'false':'true')" style="width:20px;height:20px;border:1px solid #000"></div> Docs
      <button onclick="var ok=document.getElementById('s1').getAttribute('aria-checked')==='true'&&document.getElementById('s2').getAttribute('aria-checked')==='true'; location='${redirect}?'+(ok?'code=FIXTURECODE':'error=access_denied')+'&state=${encodeURIComponent(state)}'">Continue</button>`);
  }
  if (u.pathname === "/challenge") return send(`<p>Check your phone</p>`); // not a recognized screen
  if (u.pathname === "/signin/challenge/totp") {
    // Google's authenticator-code page: the right code moves on to the consent summary, anything else stays put.
    return send(`<input name="totpPin" id="totpPin" type="tel" autocomplete="one-time-code"><button id="totpNext" onclick="if(document.getElementById('totpPin').value==='123456'){location='/signin/oauth/v2/consentsummary?${carry}'}">Next</button>`);
  }
  if (u.pathname === "/signin/challenge/dp") return send(`<p>2-Step Verification: tap Yes on your phone</p>`);
  if (u.pathname === "/mystery") return send(`<p>Something new from Google</p>`);
  if (u.pathname === "/leave") { res.statusCode = 302; res.setHeader("location", `http://localhost:${new URL(base).port}/elsewhere`); return void res.end(); }
  if (u.pathname === "/elsewhere") return send(`<input type="password"><button>Next</button>`);
  res.statusCode = 404; res.end("no");
}

beforeAll(async () => {
  server = http.createServer(route);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  loopback = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    // Only the redirect carries a result; the browser's follow-up favicon request must not overwrite it.
    if (u.searchParams.has("code") || u.searchParams.has("error")) delivered = { code: u.searchParams.get("code") ?? undefined, error: u.searchParams.get("error") ?? undefined, state: u.searchParams.get("state") ?? undefined };
    res.end("ok");
  });
  await new Promise<void>((r) => loopback.listen(0, "127.0.0.1", r));
  loopbackBase = `http://127.0.0.1:${(loopback.address() as AddressInfo).port}/`;
});
afterAll(async () => { server?.close(); loopback?.close(); await browser?.close(); });

const spec = (over: Partial<ConsentSpec["limits"]> = {}): ConsentSpec => ({ ...loadConsentSpec(), googleHosts: ["127.0.0.1"], limits: { ...loadConsentSpec().limits, settleMs: 60, overallTimeoutMs: 30_000, maxSteps: 12, twoFaGraceMs: 600, ...over } });
const authUrl = (p = "/o/oauth2/v2/auth", extra = "") => `${base}${p}?redirect_uri=${encodeURIComponent(loopbackBase)}&state=st-1${extra}`;

describe.skipIf(!browser)("Google consent driver (real Chromium, fake Google)", { timeout: 30_000 }, () => {
  it("signs in, ticks every scope box, continues, and stops once the redirect delivered the code", async () => {
    delivered = {};
    const ctx = await browser!.newContext();
    const lines: string[] = [];
    try {
      await driveConsent({ context: ctx, url: authUrl(), credential: { username: "me@example.com", password: PASSWORD }, isDone: () => !!(delivered.code || delivered.error), log: (l) => lines.push(l), spec: spec() });
    } finally { await ctx.close(); }
    expect(delivered).toEqual({ code: "FIXTURECODE", error: undefined, state: "st-1" });
    const joined = lines.join("\n");
    expect(joined).toMatch(/filled email, clicked Next/);
    expect(joined).toMatch(/filled password, clicked Next/);
    expect(joined).toMatch(/checked scope box 1\/2/);
    expect(joined).toMatch(/checked scope box 2\/2/);
    expect(joined).toMatch(/clicked Continue/);
    expect(joined).not.toContain(PASSWORD);
    expect(joined).not.toMatch(/\?|state=|redirect_uri/); // origin + path only: the query holds the client id and state
  });

  it("the newer v3 consent page (ARIA checkboxes) gets every scope ticked before Continue, and the screen is described in the log", async () => {
    delivered = {};
    const ctx = await browser!.newContext();
    const lines: string[] = [];
    try {
      await driveConsent({ context: ctx, url: authUrl("/signin/oauth/v3/consent"), credential: { username: "me@example.com", password: PASSWORD }, isDone: () => !!(delivered.code || delivered.error), log: (l) => lines.push(l), spec: spec() });
    } finally { await ctx.close(); }
    expect(delivered).toMatchObject({ code: "FIXTURECODE", error: undefined });
    const joined = lines.join("\n");
    expect(joined).toMatch(/consent screen: 2 checkbox\(es\), 0 checked; buttons: Continue/);
    expect(joined).toMatch(/checked scope box 1\/2/);
    expect(joined).toMatch(/checked scope box 2\/2/);
  });

  it("an unrecognized screen is reported, never guessed at", async () => {
    const ctx = await browser!.newContext();
    try {
      await expect(driveConsent({ context: ctx, url: authUrl("/mystery"), credential: { username: "u", password: "p" }, isDone: () => false, log: () => {}, spec: spec() })).rejects.toThrow(/no recognized forward control at .*\/mystery/);
    } finally { await ctx.close(); }
  });

  it("a 2-step verification nobody approves is waited on for a bounded time, then reported", async () => {
    const ctx = await browser!.newContext();
    const lines: string[] = [];
    try {
      await expect(driveConsent({ context: ctx, url: authUrl("/signin/challenge/dp"), credential: { username: "u", password: "p" }, isDone: () => false, log: (l) => lines.push(l), spec: spec() })).rejects.toThrow(/2-step verification that nobody approved/);
    } finally { await ctx.close(); }
    expect(lines.join("\n")).toMatch(/Google asked for 2-step verification/);
  });

  it("enters the authenticator code when the account has one, and never logs it", async () => {
    const ctx = await browser!.newContext();
    const lines: string[] = [];
    delivered = {};
    let asked = 0;
    try {
      await driveConsent({ context: ctx, url: authUrl("/signin/challenge/totp"), credential: { username: "me@example.com", password: "p", totp: async () => { asked++; return "123456"; } }, isDone: () => delivered.code !== undefined || delivered.error !== undefined, log: (l) => lines.push(l), spec: spec() });
    } finally { await ctx.close(); }
    expect(asked).toBe(1);
    expect(delivered).toMatchObject({ code: "FIXTURECODE", error: undefined });
    expect(lines.join("\n")).toMatch(/entered the authenticator code/);
    expect(lines.join("\n")).not.toContain("123456");
  });

  it("an authenticator page for an account with no code configured is waited on, then reported", async () => {
    const ctx = await browser!.newContext();
    try {
      await expect(driveConsent({ context: ctx, url: authUrl("/signin/challenge/totp"), credential: { username: "u", password: "p" }, isDone: () => false, log: () => {}, spec: spec() })).rejects.toThrow(/2-step verification that nobody approved/);
    } finally { await ctx.close(); }
  });

  it("stops with a clear error when the vault produces no code", async () => {
    const ctx = await browser!.newContext();
    try {
      await expect(driveConsent({ context: ctx, url: authUrl("/signin/challenge/totp"), credential: { username: "u", password: "p", totp: async () => undefined }, isDone: () => false, log: () => {}, spec: spec() })).rejects.toThrow(/produced none/);
    } finally { await ctx.close(); }
  });

  it("never acts on a page that is not on Google's own hosts", async () => {
    const ctx = await browser!.newContext();
    try {
      // /leave redirects to http://localhost:<port>/elsewhere, which shows a password form: a host that is not in googleHosts must be left alone.
      await expect(driveConsent({ context: ctx, url: authUrl("/leave"), credential: { username: "u", password: PASSWORD }, isDone: () => false, log: () => {}, spec: spec() })).rejects.toThrow(/left Google's own pages/);
      const filled = await ctx.pages()[0]?.locator("input[type=password]").inputValue().catch(() => "");
      expect(filled ?? "").toBe("");
    } finally { await ctx.close(); }
  });
});

describe.skipIf(!browser)("ACCT-C06 cc_reauth: Google consent only while the specified account is signed in (real Chromium, fake Google)", { timeout: 30_000 }, () => {
  const attempt = async (who: string) => {
    delivered = {};
    const ctx = await browser!.newContext();
    const lines: string[] = [];
    try {
      return { err: await driveConsent({ context: ctx, url: authUrl("/o/oauth2/v2/auth", `&who=${encodeURIComponent(who)}`), credential: { username: "me@example.com", password: PASSWORD }, isDone: () => !!(delivered.code || delivered.error), log: (l) => lines.push(l), spec: spec() }).then(() => undefined, (e: Error) => e), lines };
    } finally { await ctx.close(); }
  };
  it("a different Google account signed in: ACCOUNT_MISMATCH, no scope ticked, nothing consented", async () => {
    const { err, lines } = await attempt("other@example.com");
    expect(String(err?.message)).toMatch(/^ACCOUNT_MISMATCH: /);
    expect(String(err?.message)).not.toMatch(/@/);
    expect(delivered).toEqual({});
    expect(lines.join("\n")).not.toMatch(/checked scope box|clicked Continue/);
  });
  it("no signed-in Google account shown (unverifiable): ACCOUNT_NOT_AUTHORIZED, nothing consented", async () => {
    const { err, lines } = await attempt("none");
    expect(String(err?.message)).toMatch(/^ACCOUNT_NOT_AUTHORIZED: /);
    expect(delivered).toEqual({});
    expect(lines.join("\n")).not.toMatch(/checked scope box|clicked Continue/);
  });
  it("the specified account signed in: consent completes", async () => {
    const { err } = await attempt("ME@example.com");
    expect(err).toBeUndefined();
    expect(delivered).toMatchObject({ code: "FIXTURECODE" });
  });
});

describe("isGoogleHost", () => {
  it("accepts Google's own hosts and subdomains, rejects look-alikes", () => {
    const s = { googleHosts: ["accounts.google.com", "google.com"] };
    expect(isGoogleHost("https://accounts.google.com/signin", s)).toBe(true);
    expect(isGoogleHost("https://myaccount.google.com/x", s)).toBe(true);
    expect(isGoogleHost("https://google.com.evil.example/x", s)).toBe(false);
    expect(isGoogleHost("https://evilgoogle.com/x", s)).toBe(false);
    expect(isGoogleHost("not a url", s)).toBe(false);
  });
});
