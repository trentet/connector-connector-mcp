import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext } from "patchright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConsentSpec, type ConsentSpec } from "../src/browser/googleConsent.js";
import { driveSignIn, loadSignInSpec, type SignInSpec } from "../src/browser/signin.js";

/**
 * Real Chromium: a fake claude.ai on "localhost" and a fake Google on "127.0.0.1" (different hosts, so the host checks are real).
 * Covers the happy path (Continue with Google -> email -> password -> "Sign in to Claude: Continue" -> session cookie -> email confirmed)
 * and the places `cc browser signin` must stop: an Allow/consent screen, an account chooser that shows only someone else's account,
 * and claude.ai reporting a different email (the sign-in is then removed). Invented accounts and passwords only.
 */
function findChrome(): string | undefined {
  if (process.env.CC_TEST_CHROME) return process.env.CC_TEST_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  const exe = dir && `${root}/${dir}/chrome-linux/chrome`;
  return exe && fs.existsSync(exe) ? exe : undefined;
}
const browser: Browser | undefined = await chromium.launch({ headless: true, executablePath: findChrome() }).catch(() => undefined);

const EMAIL = "second@example.test", PASSWORD = "pw-FIXTURE-signin-7777";
let claude: http.Server, google: http.Server, cBase = "", gBase = "";
let accountEmail = EMAIL, typed: { email?: string; password?: string } = {};
const html = (b: string) => `<!doctype html><html><body>${b}</body></html>`;

beforeAll(async () => {
  google = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", gBase);
    const flow = u.searchParams.get("flow") ?? "ok";
    const send = (b: string) => { res.setHeader("content-type", "text/html"); res.end(html(b)); };
    if (u.pathname === "/o/oauth2/auth") return send(`<input id="identifierId" type="email"><button id="identifierNext" onclick="location='/pw?flow=${flow}&e='+encodeURIComponent(document.getElementById('identifierId').value)">Next</button>`);
    if (u.pathname === "/pw") { typed.email = u.searchParams.get("e") ?? undefined; return send(`<input type="password" name="Passwd" id="p"><button id="passwordNext" onclick="location='/done?flow=${flow}&p='+encodeURIComponent(document.getElementById('p').value)">Next</button>`); }
    if (u.pathname === "/done") {
      typed.password = u.searchParams.get("p") ?? undefined;
      const back = `${cBase}/callback`;
      if (flow === "allow") return send(`<label><input type="checkbox"> See your files</label><button onclick="location='${back}'">Allow</button>`);
      return send(`<p>Sign in to Claude</p><button onclick="location='${back}'">Continue</button>`);
    }
    if (u.pathname === "/accountchooser") return send(`<div role="link" onclick="location='${cBase}/callback'">Someone Else other@example.test</div><div role="link">Use another account</div>`);
    res.statusCode = 404; res.end("no");
  });
  await new Promise<void>((r) => google.listen(0, "127.0.0.1", r));
  gBase = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
  claude = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", cBase);
    if (u.pathname === "/login") { res.setHeader("content-type", "text/html"); return res.end(html(`<button onclick="location='${gBase}' + (window.FLOW==='chooser' ? '/accountchooser' : '/o/oauth2/auth?flow=' + (window.FLOW||'ok'))">Continue with Google</button><script>window.FLOW=new URLSearchParams(document.cookie.replace(/; /g,'&')).get('flow')</script>`)); }
    if (u.pathname === "/callback") { res.statusCode = 302; res.setHeader("set-cookie", "sessionKey=sk-FIXTURE; Path=/"); res.setHeader("location", "/new"); return res.end(); }
    if (u.pathname === "/new") { res.setHeader("content-type", "text/html"); return res.end(html("<p>chats</p>")); }
    if (u.pathname === "/api/account") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ email_address: accountEmail })); }
    res.statusCode = 404; res.end("no");
  });
  await new Promise<void>((r) => claude.listen(0, "127.0.0.1", r));
  cBase = `http://localhost:${(claude.address() as AddressInfo).port}`;
});
afterAll(async () => { claude?.close(); google?.close(); await browser?.close(); });

const gspec = (): ConsentSpec => ({ ...loadConsentSpec(), googleHosts: ["127.0.0.1"], limits: { ...loadConsentSpec().limits, settleMs: 60, maxSteps: 12, twoFaGraceMs: 600, sameUrlStreak: 4 } });
const sspec = (): SignInSpec => ({ ...loadSignInSpec(), url: `${cBase}/login`, accountUrl: `${cBase}/api/account`, timeoutMs: 20_000, settleMs: 100 });
async function attempt(flow: string): Promise<{ ctx: BrowserContext; run: Promise<Awaited<ReturnType<typeof driveSignIn>>> }> {
  const ctx = await browser!.newContext();
  await ctx.addCookies([{ name: "flow", value: flow, url: cBase }]);
  const hasSession = async () => (await ctx.cookies(cBase)).some((c) => c.name === "sessionKey");
  return { ctx, run: driveSignIn({ context: ctx, credential: { username: EMAIL, password: PASSWORD }, email: EMAIL, hasSession, spec: sspec(), google: gspec() }) };
}

describe.skipIf(!browser)("cc browser signin (real Chromium, fake claude.ai and Google)", { timeout: 30_000 }, () => {
  it("signs in with the vault email and password, clicks Google's Continue, and confirms the email", async () => {
    typed = {}; accountEmail = EMAIL;
    const { ctx, run } = await attempt("ok");
    const r = await run;
    expect(r).toMatchObject({ status: "signed-in", email: EMAIL, confirmed: true });
    expect(typed).toEqual({ email: EMAIL, password: PASSWORD });
    expect(r.steps.join("\n")).not.toContain(PASSWORD);
    expect((await ctx.cookies(cBase)).some((c) => c.name === "sessionKey")).toBe(true);
    await ctx.close();
  });
  it("already signed in: changes nothing and only confirms", async () => {
    accountEmail = EMAIL;
    const { ctx, run } = await attempt("ok");
    await ctx.addCookies([{ name: "sessionKey", value: "sk-OLD", url: cBase }]);
    expect(await run).toMatchObject({ status: "already-signed-in", confirmed: true });
    await ctx.close();
  });
  it("never clicks Allow or ticks a box (an access-request screen stops it)", async () => {
    const { ctx, run } = await attempt("allow");
    await expect(run).rejects.toThrow(/no recognized sign-in control/);
    expect((await ctx.cookies(cBase)).some((c) => c.name === "sessionKey")).toBe(false);
    await ctx.close();
  });
  it("never picks someone else's account from Google's account chooser", async () => {
    const { ctx, run } = await attempt("chooser");
    await expect(run).rejects.toThrow(/no recognized sign-in control/);
    expect((await ctx.cookies(cBase)).some((c) => c.name === "sessionKey")).toBe(false);
    await ctx.close();
  });
  it("a sign-in that claude.ai reports as another email is removed and reported", async () => {
    accountEmail = "other@example.test";
    const { ctx, run } = await attempt("ok");
    await expect(run).rejects.toThrow(/different account/);
    expect((await ctx.cookies(cBase)).some((c) => c.name === "sessionKey")).toBe(false);
    await ctx.close();
    accountEmail = EMAIL;
  });
});
