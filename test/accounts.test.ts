import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountMaster, loadAccounts, pickAccount, validateAccounts, type Accounts } from "../src/core/accounts.js";
import { accountCredential } from "../src/browser/signin.js";
import { parseFlags } from "../src/cli.js";
import { run } from "../src/core/runner.js";
import { PLATFORMS, type Platform, type Registry } from "../src/core/types.js";
import type { BrowserSession } from "../src/browser/chrome.js";
import type { PlatformAdapter } from "../src/adapters/types.js";

// Invented accounts only.
const ACC: Accounts = {
  version: 1, default: "first",
  accounts: [
    { id: "first", email: "first@example.test", platforms: [...PLATFORMS], signIn: { google: { vaultLabel: "Google (first)" } } },
    { id: "second", email: "second@example.test", platforms: ["claude"], master: "browser-master-second", signIn: { google: { vaultLabel: "Google (second)" } } },
  ],
};

describe("accounts file", () => {
  it("the checked-in registry/accounts.json is valid and has one default master", () => {
    const a = loadAccounts();
    expect(validateAccounts(a)).toEqual([]);
    expect(a.accounts.filter((x) => !x.master)).toHaveLength(1);
  });
  it("rejects duplicates, paths as master folders, two default masters and an unknown default", () => {
    expect(validateAccounts({ ...ACC, default: "nope" }).join()).toMatch(/default/);
    expect(validateAccounts({ ...ACC, accounts: [ACC.accounts[0], { ...ACC.accounts[1], master: "../elsewhere" }] }).join()).toMatch(/plain folder name/);
    expect(validateAccounts({ ...ACC, accounts: [ACC.accounts[0], { ...ACC.accounts[1], master: undefined }] }).join()).toMatch(/only one account/);
    expect(validateAccounts({ ...ACC, accounts: [ACC.accounts[0], { ...ACC.accounts[0] }] }).join()).toMatch(/duplicate/);
    expect(validateAccounts({ ...ACC, accounts: [{ ...ACC.accounts[0], platforms: ["myspace" as Platform] }] }).join()).toMatch(/platforms/);
  });
  it("picks the named account, else CC_ACCOUNT, else the default; never falls back on an unknown id", () => {
    expect(pickAccount(ACC, "second", {}).id).toBe("second");
    expect(pickAccount(ACC, undefined, { CC_ACCOUNT: "second" }).id).toBe("second");
    expect(pickAccount(ACC, undefined, {}).id).toBe("first");
    expect(() => pickAccount(ACC, "ghost", {})).toThrow(/unknown account "ghost"/);
  });
  it("each non-default account gets its own master next to the default one", () => {
    const def = path.join("base", "browser-master");
    expect(accountMaster(ACC.accounts[0], def)).toBe(def);
    expect(accountMaster(ACC.accounts[1], def)).toBe(path.join("base", "browser-master-second"));
  });
  it("no account email or non-default account id appears in src/ (account facts are data)", () => {
    const a = loadAccounts();
    const terms = a.accounts.flatMap((x) => [x.email, x.id === a.default ? undefined : x.id, x.master, x.signIn?.google?.vaultLabel]).filter((t): t is string => !!t);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const hits = walk("src").flatMap((f) => { const t = fs.readFileSync(f, "utf8").toLowerCase(); return terms.filter((x) => t.includes(x.toLowerCase())).map((x) => `${f}: ${x}`); });
    expect(hits).toEqual([]);
  });
});

describe("--account", () => {
  it("is parsed for platform ops and needs a value", () => {
    const p = parseFlags(["helm-x", "--platform", "claude", "--account", "second"]);
    expect(p).toMatchObject({ ids: ["helm-x"], platforms: ["claude"], account: "second" });
    expect(parseFlags(["--account"])).toEqual({ error: expect.stringMatching(/account id/) });
    expect(parseFlags(["--account", "--dry-run"])).toEqual({ error: expect.stringMatching(/account id/) });
  });
});

describe("runner with accounts", () => {
  const reg: Registry = { version: 1, connectors: [{ id: "demo", name: "Demo", url: { type: "literal", value: "https://demo.example.test/mcp" }, auth: { mode: "none" }, platforms: [...PLATFORMS] }] };
  const harness = () => {
    const masters: Record<string, string | undefined> = {};
    const fake = { close: async () => {}, touched: new Set<string>() } as unknown as BrowserSession;
    const adapter = (p: Platform): PlatformAdapter => ({ platform: p, list: async () => ({ names: ["Demo"] }), add: async () => ({ status: "ok" }), remove: async () => ({ status: "ok" }), update: async () => ({ status: "ok" }), verify: async (ctx) => { await ctx.session(); return { status: "ok", detail: "seen" }; }, probe: async () => ({ status: "ok" }) });
    return { masters, adapters: Object.fromEntries(PLATFORMS.map((p) => [p, adapter(p)])), sessionFactory: async (p: Platform, m?: string) => { masters[p] = m; return fake; } };
  };
  it("opens the account's own master and skips the platforms the account is not used on", async () => {
    const h = harness();
    const res = await run(reg, { op: "verify", connectors: ["demo"], platforms: [...PLATFORMS], account: "second" }, { accounts: ACC, adapters: h.adapters, sessionFactory: h.sessionFactory });
    expect(res.ok).toBe(true);
    expect(res.items.map((i) => [i.platform, i.status, i.account])).toEqual([["claude", "ok", "second"], ["chatgpt", "skipped", "second"], ["grok", "skipped", "second"]]);
    expect(h.masters).toEqual({ claude: "browser-master-second" });
  });
  it("the default account keeps the default master and untagged results (unchanged behaviour)", async () => {
    const h = harness();
    const res = await run(reg, { op: "verify", connectors: ["demo"], platforms: [...PLATFORMS] }, { accounts: ACC, adapters: h.adapters, sessionFactory: h.sessionFactory });
    expect(res.items.every((i) => i.status === "ok" && i.account === undefined)).toBe(true);
    expect(Object.keys(h.masters).sort()).toEqual([...PLATFORMS].sort());
    expect(Object.values(h.masters).every((m) => m === undefined)).toBe(true);
  });
  it("an unknown account fails the call without opening a browser", async () => {
    const h = harness();
    const res = await run(reg, { op: "verify", connectors: ["demo"], platforms: ["claude"], account: "ghost" }, { accounts: ACC, adapters: h.adapters, sessionFactory: h.sessionFactory });
    expect(res.ok).toBe(false);
    expect(res.items[0].detail).toMatch(/unknown account/);
    expect(h.masters).toEqual({});
  });
});

describe("account credential from the vault", () => {
  const second = ACC.accounts[1];
  it("uses the entry, and fills in the account email when the entry has no username", async () => {
    const c = await accountCredential(second, 0, { vault: async () => ({ password: "pw-INVENTED-1" }) });
    expect(c).toMatchObject({ username: "second@example.test", password: "pw-INVENTED-1" });
  });
  it("refuses an entry whose username is another email (never signs the wrong account in)", async () => {
    await expect(accountCredential(second, 0, { vault: async () => ({ username: "first@example.test", password: "pw-INVENTED-2" }) })).rejects.toThrow(/different email/);
  });
  it("waits for a missing entry when asked, and says what to add without printing a secret", async () => {
    const lines: string[] = [];
    let waited = 0;
    const c = await accountCredential(second, 60_000, { vault: async () => undefined, waitForVault: async (_l, ms) => { waited = ms; return { username: "second@example.test", password: "pw-INVENTED-3" }; } }, (l) => lines.push(l));
    expect(waited).toBe(60_000);
    expect(c.password).toBe("pw-INVENTED-3");
    expect(lines.join("\n")).toMatch(/Google \(second\)/);
    expect(lines.join("\n")).not.toContain("pw-INVENTED");
  });
  it("fails clearly when the entry is still missing", async () => {
    await expect(accountCredential(second, 0, { vault: async () => undefined })).rejects.toThrow(/has no password/);
  });
});
