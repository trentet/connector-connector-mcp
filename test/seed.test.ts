// @reqs ACCT-C08
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "patchright";
import { describe, expect, it } from "vitest";
import { AccountMismatchError, AccountNotAuthorizedError } from "../src/core/accountChoice.js";
import { seedMaster, verifySeedSource, type SeedAccount } from "../src/browser/seed.js";

const A = "first@example.test", B = "second@example.test";
const acct = (over: Partial<SeedAccount> = {}): SeedAccount => ({ id: "main", email: A, platforms: ["claude", "chatgpt"], ...over });
const fails = async (p: Promise<unknown>, cls: typeof AccountNotAuthorizedError | typeof AccountMismatchError, code: RegExp) => {
  const e = await p.then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(cls);
  expect(String((e as Error).message)).toMatch(code);
};

describe("ACCT-C08 verifySeedSource: the source browser must show the named account on every platform", () => {
  it("the named account on every platform passes", async () => {
    await expect(verifySeedSource(acct(), async () => A.toUpperCase())).resolves.toBeUndefined();
  });
  it("another account on any one platform is ACCOUNT_MISMATCH", async () => {
    await fails(verifySeedSource(acct(), async (p) => (p === "chatgpt" ? B : A)), AccountMismatchError, /ACCOUNT_MISMATCH: /);
  });
  it("an unreadable account (no reader, nothing read, or the read failed) is ACCOUNT_NOT_AUTHORIZED", async () => {
    await fails(verifySeedSource(acct({ platforms: ["claude", "grok"] }), async (p) => (p === "grok" ? undefined : A)), AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /);
    await fails(verifySeedSource(acct(), async () => { throw new Error("page crashed"); }), AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /);
  });
  it("an account with no email, or no platforms, is refused before anything is read", async () => {
    let reads = 0;
    await fails(verifySeedSource(acct({ email: undefined }), async () => { reads++; return A; }), AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /);
    await fails(verifySeedSource(acct({ platforms: [] }), async () => { reads++; return A; }), AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /);
    expect(reads).toBe(0);
  });
});

describe("ACCT-C08 cc browser seed: nothing is read, copied or written unless the source shows the named account", () => {
  const fakeSource = () => {
    const h = { cookiesRead: 0, pagesOpened: 0, pagesClosed: 0, closed: 0 };
    const page = { close: async () => { h.pagesClosed++; } } as unknown as Page;
    const ctx = { newPage: async () => { h.pagesOpened++; return page; }, cookies: async () => { h.cookiesRead++; return []; } };
    const browser = { contexts: () => [ctx], close: async () => { h.closed++; } } as unknown as Browser;
    return { h, connect: async () => browser };
  };
  const master = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-seed-")), "master");
  for (const [name, seen, cls, code] of [
    ["another account signed in", B, AccountMismatchError, /ACCOUNT_MISMATCH: /],
    ["no account readable", undefined, AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /],
  ] as const) {
    it(`${name}: refused, no cookie read, the master profile is not created`, async () => {
      const src = fakeSource(), m = master();
      await fails(seedMaster(9, m, { account: acct(), connect: src.connect, readIdentity: async () => seen }), cls, code);
      expect(src.h.cookiesRead).toBe(0);
      expect(src.h).toMatchObject({ pagesOpened: 1, pagesClosed: 1, closed: 1 });
      expect(fs.existsSync(m)).toBe(false);
    });
  }
  it("no account named: refused before connecting to the source browser", async () => {
    const src = fakeSource();
    await fails(seedMaster(9, master(), undefined as never), AccountNotAuthorizedError, /ACCOUNT_NOT_AUTHORIZED: /);
    expect(src.h.pagesOpened).toBe(0);
  });
});
