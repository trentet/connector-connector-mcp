// @reqs ACCT-001 ACCT-002 ACCT-003 ACCT-C01 ACCT-C02 ACCT-C03 ACCT-C04 ACCT-C05 ACCT-C06 ACCT-C07
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { chromium, type Browser } from "patchright";
import { afterAll, describe, expect, it } from "vitest";
import { pickAccount, type Accounts } from "../src/core/accounts.js";
import { AccountMismatchError, AccountNotAuthorizedError, assertLoginAccount, assertSameAccount, assertSignInAccount, signInService } from "../src/core/accountChoice.js";
import { lookupAccount, verifyEntry, type Lookup, type RegistryItem } from "../src/core/accountRegistry.js";
import { advanceOneStep, assertGoogleAccount, clickAccountChooserEntry, googleIdentity, loadConsentSpec } from "../src/browser/googleConsent.js";
import { loadIdentityProbes, openVerifiedSession, readPlatformIdentity } from "../src/browser/identity.js";
import { runThreads } from "../src/threads.js";
import { run } from "../src/core/runner.js";
import type { Registry } from "../src/core/types.js";
import type { BrowserSession } from "../src/browser/chrome.js";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { defaultSigninFn } from "../src/server/app.js";

const A = "first@example.test";
const B = "second@example.test";

const accounts = (n: number): Accounts => ({
  version: 1,
  default: "main",
  accounts: [
    { id: "main", email: A, platforms: ["claude"], signIn: { google: { vaultLabel: "Google main" } } },
    ...(n > 1 ? [{ id: "second-acct", email: B, platforms: ["claude"], master: "m-second", signIn: { google: { vaultLabel: "Google second" } } }] : []),
    { id: "nosignin", platforms: ["claude"], master: "m-nosignin" },
  ],
} as unknown as Accounts);

const reg = (byService: Record<string, Lookup>) => async (s: string): Promise<Lookup> => byService[s] ?? { status: "none", service: s };
const authorized = (service: string, account: string): Lookup => ({ status: "authorized", service, account });
const failsWith = async (p: Promise<unknown> | (() => unknown), cls: typeof AccountNotAuthorizedError | typeof AccountMismatchError, code: RegExp) => {
  const e = typeof p === "function" ? (() => { try { p(); return undefined; } catch (x) { return x; } })() : await p.then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(cls);
  expect(String((e as Error).message)).toMatch(code);
};
const refused = (p: Promise<unknown> | (() => unknown)) => failsWith(p, AccountNotAuthorizedError, /^ACCOUNT_NOT_AUTHORIZED: /);
const mismatched = (p: Promise<unknown> | (() => unknown)) => failsWith(p, AccountMismatchError, /^ACCOUNT_MISMATCH: /);

describe("ACCT-003 the signed-in account must be exactly the specified one", () => {
  it("match allowed (case and spaces ignored); mismatch refused; unknown refused; nothing specified refused", async () => {
    assertSameAccount("x", A, ` ${A.toUpperCase()} `);
    assertSameAccount("x", A, [A, A]);
    await mismatched(() => assertSameAccount("x", A, B));
    await mismatched(() => assertSameAccount("x", A, [A, B]));
    await refused(() => assertSameAccount("x", A, undefined));
    await refused(() => assertSameAccount("x", A, []));
    await refused(() => assertSameAccount("x", A, ""));
    await refused(() => assertSameAccount("x", undefined, A));
  });
  it("refusals never echo an account email", () => {
    for (const f of [() => assertSameAccount("x", A, B), () => assertSameAccount("x", A, undefined)]) {
      try { f(); } catch (e) { expect(String((e as Error).message)).not.toMatch(/@/); }
    }
  });
});

describe("ACCT-001 ACCT-C01 cc_signin / cc browser: the account is the one named in the call, nothing else", () => {
  it("no --account: refused even with a default, CC_ACCOUNT and only one account that can sign in", async () => {
    await refused(() => pickAccount(accounts(2), undefined, { CC_ACCOUNT: "second-acct" }, "explicit"));
    await refused(() => pickAccount(accounts(1), undefined, { CC_ACCOUNT: "main" }, "explicit"));
  });
  it("a named account is that account; unknown ids still fail", () => {
    expect(pickAccount(accounts(2), "second-acct", {}, "explicit").id).toBe("second-acct");
    expect(() => pickAccount(accounts(2), "nope", {}, "explicit")).toThrow(/unknown account/);
  });
  it("the named account must carry its email; an owner registry entry must agree; tampered refuses", async () => {
    const all = accounts(2);
    const second = all.accounts[1]!;
    await refused(assertSignInAccount(all.accounts.find((a) => a.id === "nosignin")!, { lookup: reg({}) }));
    await assertSignInAccount(second, { lookup: reg({}) });
    await assertSignInAccount(second, { lookup: reg({ [signInService("second-acct")]: authorized(signInService("second-acct"), B) }) });
    await mismatched(assertSignInAccount(second, { lookup: reg({ [signInService("second-acct")]: authorized(signInService("second-acct"), A) }) }));
    await refused(assertSignInAccount(second, { lookup: reg({ [signInService("second-acct")]: { status: "tampered", service: "x", reason: "bad" } }) }));
  });
  it("cc_signin's default handler with no account refuses before any browser or vault is touched (one account or two)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-acct-"));
    for (const n of [1, 2]) {
      const file = path.join(dir, `accounts-${n}.json`);
      fs.writeFileSync(file, JSON.stringify(accounts(n)));
      await refused(defaultSigninFn(file, undefined, 0));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("ACCT-C02 grok.com email login only for the run's specified account", () => {
  const label = "Grok (grok.com email login)";
  const base = { service: "grok.com", label, username: A, expected: A };
  it("no account specified for the run: refused", async () => {
    await refused(assertLoginAccount({ ...base, expected: undefined }, { lookup: reg({}) }));
  });
  it("the vault entry is another account than the run's: refused", async () => {
    await mismatched(assertLoginAccount({ ...base, expected: B }, { lookup: reg({}) }));
  });
  it("the vault entry is the run's account: allowed; an owner entry naming someone else or tampered refuses", async () => {
    await assertLoginAccount(base, { lookup: reg({}) });
    await assertLoginAccount({ ...base, username: "FIRST@example.test" }, { lookup: reg({ "grok.com": authorized("grok.com", A) }) });
    await mismatched(assertLoginAccount(base, { lookup: reg({ "grok.com": authorized("grok.com", B) }) }));
    await refused(assertLoginAccount(base, { lookup: reg({ "grok.com": { status: "tampered", service: "grok.com", reason: "bad" } }) }));
  });
});

describe("ACCT-C07 cc threads / cc settings: the named account is verified signed in before anything is read or changed", () => {
  const fake = () => { const h = { opened: 0, closed: 0 }; const s = { close: async () => { h.closed++; } } as unknown as BrowserSession; return { h, open: async () => { h.opened++; return s; }, s }; };
  it("signed in as the named account: the session is returned", async () => {
    const f = fake();
    expect(await openVerifiedSession("claude", A, f.open, async () => A.toUpperCase())).toBe(f.s);
    expect(f.h).toEqual({ opened: 1, closed: 0 });
  });
  it("another account signed in: ACCOUNT_MISMATCH and the session is closed", async () => {
    const f = fake();
    await failsWith(openVerifiedSession("claude", A, f.open, async () => B), AccountMismatchError, /ACCOUNT_MISMATCH: /);
    expect(f.h).toEqual({ opened: 1, closed: 1 });
  });
  it("signed-in account unknown (nothing read, or the reader failed): ACCOUNT_NOT_AUTHORIZED and the session is closed", async () => {
    for (const read of [async () => undefined, async () => { throw new Error("page crashed"); }]) {
      const f = fake();
      await failsWith(openVerifiedSession("claude", A, f.open, read), AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /);
      expect(f.h).toEqual({ opened: 1, closed: 1 });
    }
  });
  it("no account specified: refused before any browser opens", async () => {
    const f = fake();
    await failsWith(openVerifiedSession("claude", undefined, f.open, async () => A), AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /);
    expect(f.h.opened).toBe(0);
  });
  it("cc threads with a session signed in as another account reads nothing and reports the refusal", async () => {
    const f = fake();
    const rep = await runThreads({ open: () => openVerifiedSession("claude", A, f.open, async () => B), account: "main" });
    expect(rep.ok).toBe(false);
    expect(JSON.stringify(rep)).toContain("ACCOUNT_MISMATCH");
    expect(f.h.closed).toBe(1);
  });
});

describe("ACCT-C05 cc_run: the run's account is required and each session's signed-in account is verified", () => {
  const demo: Registry = { version: 1, connectors: [{ id: "demo", name: "Demo", url: { type: "literal", value: "https://demo.example.test/mcp" }, auth: { mode: "none" }, platforms: ["claude"] }] };
  const harness = (seen: string | undefined) => {
    const h = { opened: 0, closed: 0, acted: 0, read: 0 };
    const fake = { close: async () => { h.closed++; }, touched: new Set<string>() } as unknown as BrowserSession;
    const adapter: PlatformAdapter = { platform: "claude", list: async () => ({ names: [] }), add: async () => ({ status: "ok" }), remove: async () => ({ status: "ok" }), update: async () => ({ status: "ok" }), verify: async (ctx) => { await ctx.session(); h.acted++; return { status: "ok" }; }, probe: async () => ({ status: "ok" }) };
    const opts = { accounts: accounts(2), adapters: { claude: adapter }, sessionFactory: async () => { h.opened++; return fake; }, readIdentity: async () => { h.read++; return seen; } };
    return { h, opts };
  };
  const req = (account?: string) => ({ op: "verify" as const, connectors: ["demo"], platforms: ["claude" as const], ...(account ? { account } : {}) });
  it("no account specified: every item refused, no browser opened", async () => {
    const { h, opts } = harness(A);
    const r = await run(demo, req(), opts);
    expect(r.ok).toBe(false);
    expect(r.items[0]!.detail).toMatch(/^ACCOUNT_NOT_AUTHORIZED: /);
    expect(h).toMatchObject({ opened: 0, acted: 0 });
  });
  it("signed in as the run's account: allowed", async () => {
    const { h, opts } = harness(A);
    const r = await run(demo, req("main"), opts);
    expect(r.ok).toBe(true);
    expect(h).toMatchObject({ opened: 1, read: 1, acted: 1 });
  });
  it("signed in as another account: refused, session closed, the adapter never acts", async () => {
    const { h, opts } = harness(B);
    const r = await run(demo, req("main"), opts);
    expect(r.ok).toBe(false);
    expect(r.items[0]!.detail).toMatch(/ACCOUNT_MISMATCH: /);
    expect(h.acted).toBe(0);
    expect(h.closed).toBeGreaterThanOrEqual(1);
  });
  it("signed-in account unknown (no reader, unreadable, or the reader failed): refused", async () => {
    for (const seen of [undefined, ""]) {
      const { h, opts } = harness(seen);
      const r = await run(demo, req("main"), opts);
      expect(r.items[0]!.detail).toMatch(/ACCOUNT_NOT_AUTHORIZED: /);
      expect(h.acted).toBe(0);
    }
    const { h, opts } = harness(A);
    const r = await run(demo, req("main"), { ...opts, readIdentity: async () => { throw new Error("page crashed"); } });
    expect(r.items[0]!.detail).toMatch(/ACCOUNT_NOT_AUTHORIZED: /);
    expect(h.acted).toBe(0);
  });
  it("grok has no identity reader, so its signed-in account is unknown (refused) and nothing is navigated", async () => {
    expect(loadIdentityProbes().grok?.fetch).toBeUndefined();
    let navigated = 0;
    const s = { page: { goto: async () => { navigated++; }, evaluate: async () => ({}) } } as unknown as BrowserSession;
    expect(await readPlatformIdentity("grok", s)).toBeUndefined();
    expect(navigated).toBe(0);
    expect(loadIdentityProbes().claude).toMatchObject({ fetch: "https://claude.ai/api/account", emailField: "email_address" });
  });
});

describe("ACCT-C04 registry entries are verified against vault-mcp's key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const entry = (service: string, account: string, key = privateKey): RegistryItem => {
    const issued = "2026-11-11T23:00:00.000Z";
    const sig = sign(null, Buffer.from(`account-authorization-v1|${service}|${account}|${issued}`), key).toString("base64url");
    return { name: `account-authorization/${service}`, notes: `service=${service}\nissued_at=${issued}\nauth_sig=${sig}`, login: { username: account } };
  };
  it("a signed entry is authorized; another key, a changed account or no signature is tampered", () => {
    expect(verifyEntry("grok.com", entry("grok.com", A), pem)).toEqual(authorized("grok.com", A));
    expect(verifyEntry("grok.com", entry("grok.com", A, other.privateKey), pem).status).toBe("tampered");
    expect(verifyEntry("grok.com", { ...entry("grok.com", A), login: { username: B } }, pem).status).toBe("tampered");
    expect(verifyEntry("grok.com", { name: "account-authorization/grok.com", login: { username: A } }, pem).status).toBe("tampered");
  });
  it("two entries for one service are tampered; none is none; an unreachable vault is unavailable", async () => {
    const src = (items: RegistryItem[]) => ({ listItems: async () => items, publicKeyPem: async () => pem });
    expect((await lookupAccount("WWW.Grok.com", src([entry("grok.com", A)]))).status).toBe("authorized");
    expect((await lookupAccount("grok.com", src([entry("grok.com", A), entry("grok.com", B)]))).status).toBe("tampered");
    expect((await lookupAccount("grok.com", src([entry("cc-signin:main", A)]))).status).toBe("none");
    expect((await lookupAccount("grok.com", { listItems: async () => { throw new Error("down"); }, publicKeyPem: async () => pem })).status).toBe("unavailable");
  });
});

function findChrome(): string | undefined {
  if (process.env.CC_TEST_CHROME) return process.env.CC_TEST_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  if (!dir) return undefined;
  return ["chrome-win64", "chrome-win"].map((d) => path.join(root, dir, d, "chrome.exe")).find((exe) => fs.existsSync(exe));
}
const browser: Browser | undefined = await chromium.launch({ headless: true, executablePath: findChrome() }).catch(() => undefined);
afterAll(async () => { await browser?.close(); }, 30_000); // closing Chromium can take >10s while the full suite loads the host

describe.skipIf(!browser)("ACCT-C03 the Google account chooser: only our own tile, never the first one (real Chromium)", { timeout: 30_000 }, () => {
  const html = `<body><ul>
    <li id="t1" onclick="document.body.dataset.clicked='t1'">Trent One ${A}</li>
    <li id="t2" onclick="document.body.dataset.clicked='t2'">Trent Two ${B}</li>
    <li id="t3" onclick="document.body.dataset.clicked='t3'">Use another account</li></ul>
    <div role="button" onclick="document.body.dataset.clicked='both'">${A} ${B}</div></body>`;
  const clicked = async (ownEmail?: string) => {
    const page = await browser!.newPage();
    try {
      await page.setContent(html);
      const r = await clickAccountChooserEntry(page, loadConsentSpec(), ownEmail);
      return { r, clicked: await page.evaluate(() => document.body.dataset.clicked ?? "") };
    } finally { await page.close(); }
  };
  it("no own account: nothing is clicked (the old first-tile fallback is gone)", async () => {
    expect(await clicked(undefined)).toEqual({ r: undefined, clicked: "" });
  });
  it("our account not on the chooser: nothing is clicked", async () => {
    expect(await clicked("third@example.test")).toEqual({ r: undefined, clicked: "" });
  });
  it("our account on the chooser: exactly its tile, never an element naming two accounts", async () => {
    const out = await clicked(B.toUpperCase());
    expect(out.clicked).toBe("t2");
    expect(out.r).toMatch(/our own account/);
  }, 20000);
});

describe.skipIf(!browser)("ACCT-C05 the claude identity reader against a fake claude.ai (real Chromium)", { timeout: 30_000 }, () => {
  it("reads the email from the account endpoint; no email is unknown", async () => {
    let email: string | undefined = A;
    const srv = http.createServer((req, res) => {
      if (req.url === "/api/account") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(email ? { email_address: email } : {})); }
      res.setHeader("content-type", "text/html"); res.end("<p>chats</p>");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const page = await browser!.newPage();
    try {
      const probes = { claude: { page: `${base}/`, fetch: `${base}/api/account`, emailField: "email_address", liveVerified: false, note: "test" } };
      const s = { page } as unknown as BrowserSession;
      expect(await readPlatformIdentity("claude", s, probes)).toBe(A);
      email = undefined;
      expect(await readPlatformIdentity("claude", s, probes)).toBeUndefined();
    } finally { await page.close(); srv.close(); }
  });
});

describe.skipIf(!browser)("ACCT-C06 cc_reauth / cc_signin: Google pages are acted on only while showing the specified account (real Chromium)", { timeout: 30_000 }, () => {
  const spec = loadConsentSpec();
  const onPage = async <T>(html: string, f: (p: import("patchright").Page) => Promise<T>) => {
    const page = await browser!.newPage();
    try { await page.setContent(html); return await f(page); } finally { await page.close(); }
  };
  const consent = (chip: string) => `<body>${chip}<button onclick="document.body.dataset.clicked='allow'">Allow</button><button onclick="document.body.dataset.clicked='continue'">Continue</button></body>`;
  const clicked = (p: import("patchright").Page) => p.evaluate(() => document.body.dataset.clicked ?? "");
  it("reads [data-email] and the account chip's aria-label", async () => {
    expect(await onPage(`<div data-email="${A}"></div><a aria-label="Google Account: Someone (${B})"></a><p>${B} in text is not identity</p>`, (p) => googleIdentity(p, spec))).toEqual([A, B]);
    expect(await onPage(`<p>${A}</p>`, (p) => googleIdentity(p, spec))).toEqual([]);
  });
  it("own account shown: allowed and the step proceeds", async () => {
    await onPage(consent(`<div data-email="${A}"></div>`), async (p) => {
      await assertGoogleAccount(p, spec, A);
      expect(await advanceOneStep(p, { username: A }, spec, "consent")).toBe("clicked Continue");
      expect(await clicked(p)).toBe("continue");
    });
  });
  it("another account signed in: ACCOUNT_MISMATCH and nothing is clicked (consent and sign-in modes)", async () => {
    for (const mode of ["consent", "signin"] as const) {
      await onPage(consent(`<div data-email="${B}"></div>`), async (p) => {
        await mismatched(advanceOneStep(p, { username: A }, spec, mode));
        expect(await clicked(p)).toBe("");
      });
    }
  });
  it("our account and another both shown: ACCOUNT_MISMATCH, nothing clicked", async () => {
    await onPage(consent(`<div data-email="${A}"></div><a aria-label="Google Account: X (${B})"></a>`), async (p) => {
      await mismatched(advanceOneStep(p, { username: A }, spec, "consent"));
      expect(await clicked(p)).toBe("");
    });
  });
  it("no account shown (unverifiable) or no account specified: ACCOUNT_NOT_AUTHORIZED, nothing clicked", async () => {
    await onPage(consent(""), async (p) => {
      await refused(advanceOneStep(p, { username: A }, spec, "consent"));
      expect(await clicked(p)).toBe("");
    });
    await onPage(consent(`<div data-email="${A}"></div>`), async (p) => {
      await refused(advanceOneStep(p, {}, spec, "consent"));
      expect(await clicked(p)).toBe("");
    });
  });
});
