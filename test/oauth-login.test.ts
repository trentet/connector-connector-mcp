import { describe, expect, it } from "vitest";
import { handleLoginPage, watchLogin } from "../src/browser/oauthLogin.js";
import { run } from "../src/core/runner.js";
import { validateRegistry } from "../src/core/registry.js";
import type { PlatformAdapter } from "../src/adapters/types.js";
import type { Registry } from "../src/core/types.js";

/** Page stub: a login form (password field, user field, submit), a consent page (button only), or blank. */
function fakePage(url: string, kind: "login" | "consent" | "blank") {
  const log: string[] = [];
  const el = (name: string, present: boolean) => ({ count: async () => (present ? 1 : 0), first() { return el(name, present); }, evaluate: async (_f: unknown, v?: string) => { log.push(v === undefined ? `click:${name}` : `fill:${name}`); } });
  return { log, url: () => url,
    locator: (sel: string) => sel.includes("password") ? el("password", kind === "login") : sel.includes("submit") ? el("submit", kind === "login") : el("user", kind === "login"),
    getByRole: () => el("role-button", kind === "consent") } as never as { log: string[]; url(): string };
}

describe("connector login (vault credential)", () => {
  it("fills username+password and submits on a login form; never clicks a consent page; reports a login with no credential", async () => {
    const login = fakePage("https://conn.example/login?txn=1", "login");
    expect(await handleLoginPage(login as never, { username: "u", password: "p" })).toBe("signed-in");
    expect(login.log).toEqual(["fill:user", "fill:password", "click:submit"]);
    const consent = fakePage("https://conn.example/login?txn=2", "consent");
    expect(await handleLoginPage(consent as never, { username: "u", password: "p" })).toBe("nothing");
    expect(consent.log).toEqual([]);
    expect(await handleLoginPage(fakePage("https://conn.example/login", "login") as never, undefined)).toBe("needs-login");
  });

  it("only acts on the connector's own origin, once per page", async () => {
    const mine = fakePage("https://conn.example/login?txn=1", "login");
    const platform = fakePage("https://claude.ai/settings", "login");
    const stranger = fakePage("https://evil.example/login", "login");
    const w = watchLogin({ pages: () => [mine, platform, stranger] } as never, "https://conn.example/mcp", { password: "p" }, { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 50));
    expect(await w.stop()).toEqual({ signedIn: 1, needsLogin: false });
    expect(mine.log).toEqual(["fill:password", "click:submit"]);
    expect(platform.log).toHaveLength(0);
    expect(stranger.log).toHaveLength(0);
  });

  it("registry: oauthLogin needs oauth mode and a label", () => {
    const base = { id: "x", name: "X", url: { type: "literal", value: "https://x/mcp" }, platforms: ["claude"] };
    expect(validateRegistry({ version: 1, connectors: [{ ...base, auth: { mode: "oauth", oauthLogin: { vaultLabel: "L" } } }] }).errors).toEqual([]);
    expect(validateRegistry({ version: 1, connectors: [{ ...base, auth: { mode: "none", oauthLogin: { vaultLabel: "L" } } }] }).errors.join()).toContain("oauthLogin");
    expect(validateRegistry({ version: 1, connectors: [{ ...base, auth: { mode: "oauth", oauthLogin: { vaultLabel: "" } } }] }).errors.join()).toContain("oauthLogin");
  });

  const reg: Registry = { version: 1, connectors: [
    { id: "oa", name: "OA", url: { type: "literal", value: "https://conn.example/mcp" }, auth: { mode: "oauth", oauthLogin: { vaultLabel: "L" } }, platforms: ["claude"] },
    { id: "hd", name: "HD", url: { type: "literal", value: "https://hd.example/mcp" }, auth: { mode: "none" }, platforms: ["claude"] },
  ] };
  const adapter: PlatformAdapter = { platform: "claude", list: async () => ({ names: [] }), remove: async () => ({ status: "ok" }), update: async () => ({ status: "ok" }), verify: async () => ({ status: "ok" }), probe: async () => ({ status: "ok" }),
    add: async (ctx) => { await ctx.session(); return { status: "ok", detail: "added" }; } };
  const sessionFactory = async () => ({ context: {}, close: async () => {} }) as never;
  const deps = { env: {}, readFile: () => undefined, vault: async (l: string) => (l === "L" ? { username: "operator", password: "s3cret-pw" } : undefined) };

  it("runner: watcher only for oauth connectors with oauthLogin; credential never appears in output; dry run says if the label resolves", async () => {
    const started: Array<string | undefined> = [];
    const watchLoginFn = (_c: unknown, url: string, cred: { password?: string } | undefined) => { started.push(url + "|" + (cred?.password ? "has-cred" : "no-cred")); return { stop: async () => ({ signedIn: 1, needsLogin: false }) }; };
    const res = await run(reg, { op: "add", account: "main", connectors: ["oa", "hd"], platforms: ["claude"] }, { adapters: { claude: adapter }, sessionFactory, deps, watchLogin: watchLoginFn as never });
    expect(started).toEqual(["https://conn.example/mcp|has-cred"]);
    expect(res.items.find((i) => i.connector === "oa")?.detail).toContain("signed in via vault x1");
    expect(JSON.stringify(res)).not.toContain("s3cret-pw");
    const dry = await run(reg, { op: "add", account: "main", connectors: ["oa"], platforms: ["claude"], dryRun: true }, { adapters: { claude: adapter }, deps });
    expect(dry.items[0].detail).toContain('vault "L" found');
    const dryMissing = await run(reg, { op: "add", account: "main", connectors: ["oa"], platforms: ["claude"], dryRun: true }, { adapters: { claude: adapter }, deps: { ...deps, vault: async () => undefined } });
    expect(dryMissing.items[0].detail).toContain("MISSING");
  });
});
