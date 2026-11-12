// @reqs ACCT-001 ACCT-002 ACCT-C01 ACCT-C02 ACCT-C03 ACCT-C04
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { chromium, type Browser } from "patchright";
import { afterAll, describe, expect, it } from "vitest";
import { pickAccount, type Accounts } from "../src/core/accounts.js";
import { AccountNotAuthorizedError, assertLoginAccount, assertSignInAccount, signInService } from "../src/core/accountChoice.js";
import { lookupAccount, verifyEntry, type Lookup, type RegistryItem } from "../src/core/accountRegistry.js";
import { clickAccountChooserEntry, loadConsentSpec } from "../src/browser/googleConsent.js";
import { GROK_LOGIN_HOSTS } from "../src/adapters/grok.js";
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
const refused = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(AccountNotAuthorizedError);
  expect(String((e as Error).message)).toMatch(/^ACCOUNT_NOT_AUTHORIZED/);
};

describe("ACCT-C01 a sign-in never takes the default or CC_ACCOUNT (pickAccount, cc browser signin, cc_signin)", () => {
  it("two accounts that can sign in and no --account: refused even with a default and CC_ACCOUNT set", () => {
    expect(() => pickAccount(accounts(2), undefined, { CC_ACCOUNT: "second-acct" }, "signin")).toThrow(/^ACCOUNT_NOT_AUTHORIZED/);
  });
  it("the only account that can sign in is used; a named account is that account; unknown ids still fail", () => {
    expect(pickAccount(accounts(1), undefined, { CC_ACCOUNT: "nosignin" }, "signin").id).toBe("main");
    expect(pickAccount(accounts(2), "second-acct", {}, "signin").id).toBe("second-acct");
    expect(() => pickAccount(accounts(2), "nope", {}, "signin")).toThrow(/unknown account/);
  });
  it("ordinary runs keep their account choice (ACCT-002 is about sign-in, not which profile a run uses)", () => {
    expect(pickAccount(accounts(2), undefined, {}).id).toBe("main");
    expect(pickAccount(accounts(2), undefined, { CC_ACCOUNT: "second-acct" }).id).toBe("second-acct");
  });
  it("with two accounts that can sign in, only the account the owner named for cc-signin:<id> signs in", async () => {
    const all = accounts(2);
    const second = all.accounts[1]!;
    await refused(assertSignInAccount(all, second, { lookup: reg({}) }));
    await assertSignInAccount(all, second, { lookup: reg({ [signInService("second-acct")]: authorized(signInService("second-acct"), B) }) });
    await refused(assertSignInAccount(all, second, { lookup: reg({ [signInService("second-acct")]: authorized(signInService("second-acct"), A) }) }));
    await refused(assertSignInAccount(all, second, { lookup: reg({ [signInService("second-acct")]: { status: "tampered", service: "x", reason: "bad" } }) }));
  });
  it("with one account that can sign in and no registry entry (or the registry unreachable), it signs in", async () => {
    const all = accounts(1);
    await assertSignInAccount(all, all.accounts[0]!, { lookup: reg({}) });
    await assertSignInAccount(all, all.accounts[0]!, { lookup: async (s) => ({ status: "unavailable", service: s, reason: "down" }) });
  });
  it("cc_signin's default handler refuses two possible accounts before any browser or vault is touched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-acct-"));
    const file = path.join(dir, "accounts.json");
    fs.writeFileSync(file, JSON.stringify(accounts(2)));
    await refused(defaultSigninFn(file, undefined, 0));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("ACCT-C02 grok.com email login uses the owner-named or the only possible account", () => {
  const label = "Grok (grok.com email login)";
  const base = { service: "grok.com", hosts: GROK_LOGIN_HOSTS, label, username: A };
  const logins = (rows: { name: string; username?: string; uris: string[] }[]) => async () => rows;
  it("another vault login for grok.com or x.ai with a different username: refused", async () => {
    await refused(assertLoginAccount(base, { lookup: reg({}), logins: logins([{ name: label, username: A, uris: [] }, { name: "other", username: B, uris: ["https://accounts.x.ai/sign-in"] }]) }));
    await refused(assertLoginAccount(base, { lookup: reg({}), logins: logins([{ name: "other", username: B, uris: ["grok.com"] }]) }));
  });
  it("no other account could apply: the login goes ahead", async () => {
    await assertLoginAccount(base, { lookup: reg({}), logins: logins([
      { name: label, username: A, uris: ["https://grok.com"] },
      { name: "same person", username: "FIRST@example.test", uris: ["https://x.ai"] },
      { name: "elsewhere", username: B, uris: ["https://example.org", "notgrok.com"] },
      { name: "account-authorization/grok.com", username: B, uris: ["https://grok.com"] },
    ]) });
  });
  it("an owner-named account must be the vault entry's username; a tampered entry refuses", async () => {
    await assertLoginAccount(base, { lookup: reg({ "grok.com": authorized("grok.com", A) }), logins: logins([{ name: "other", username: B, uris: ["grok.com"] }]) });
    await refused(assertLoginAccount(base, { lookup: reg({ "grok.com": authorized("grok.com", B) }), logins: logins([]) }));
    await refused(assertLoginAccount(base, { lookup: reg({ "grok.com": { status: "tampered", service: "grok.com", reason: "bad" } }), logins: logins([]) }));
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
afterAll(async () => { await browser?.close(); });

describe.skipIf(!browser)("ACCT-C03 the Google account chooser: only our own tile, never the first one (real Chromium)", () => {
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
