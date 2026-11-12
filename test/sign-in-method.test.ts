// @reqs ACCT-C12
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountMismatchError, AccountNotAuthorizedError, assertFlowMethod, assertMethodsAgree, ccMethodErrors } from "../src/core/accountChoice.js";
import { AUTO_SOURCE, cleanOptions, detectSignInOptions, loadSignInOptions, parseSite, resolveSignInMethod, siteNotes, type SignInStore, type SiteOptions } from "../src/core/signInMethod.js";
import { accountCredential } from "../src/browser/signin.js";
import type { AccountDef } from "../src/core/accounts.js";

const fakeStore = (sites: Record<string, SiteOptions> = {}, fail?: "read" | "write") => {
  const h = { sites: { ...sites }, entries: [] as { label: string; method: string; source: string }[], siteWrites: 0 };
  const store: SignInStore = {
    async readSite(site) { if (fail === "read") throw new Error("unreadable"); return h.sites[site]; },
    async writeSite(rec) { h.siteWrites++; h.sites[rec.site] = rec; },
    async writeEntryMethod(label, method, source) { if (fail === "write") throw new Error("locked"); h.entries.push({ label, method, source }); },
  };
  return { h, d: { ...ccMethodErrors, store } };
};
const L = "Some login";
const reject = async (p: Promise<unknown>) => p.then(() => undefined, (e) => e as Error & { options?: string[] });

describe("ACCT-C12 an entry's sign-in method is settled when it is pulled, never guessed", () => {
  it("an entry that records a method uses it, with no vault write and no detection", async () => {
    const { h, d } = fakeStore();
    let detected = 0;
    expect(await resolveSignInMethod({ label: L, site: "grok.com", entryMethod: " Email ", detect: async () => { detected++; return ["x"]; } }, d)).toEqual({ method: "email", source: "entry", written: false });
    expect(detected).toBe(0); expect(h.entries).toEqual([]);
    expect(await reject(resolveSignInMethod({ label: L, site: "grok.com", entryMethod: "twitter" }, d))).toBeInstanceOf(AccountNotAuthorizedError);
  });
  it("none recorded and exactly one option (stored record first, else detected): written as auto: only option, and used", async () => {
    const { h, d } = fakeStore({ "example.test": { site: "example.test", options: ["sso"], detectedAt: "t", source: "detected" } });
    expect(await resolveSignInMethod({ label: L, site: "example.test", detect: async () => ["email", "google"] }, d)).toEqual({ method: "sso", source: AUTO_SOURCE, written: true });
    expect(await resolveSignInMethod({ label: "Other", site: "solo.test", detect: async () => ["google"] }, d)).toMatchObject({ method: "google", written: true });
    expect(h.entries).toEqual([{ label: L, method: "sso", source: "auto: only option" }, { label: "Other", method: "google", source: "auto: only option" }]);
    expect(AUTO_SOURCE).toBe("auto: only option");
  });
  it("a dry run reports the only option without writing it", async () => {
    const { h, d } = fakeStore();
    expect(await resolveSignInMethod({ label: L, site: "solo.test", detect: async () => ["google"], write: false }, d)).toEqual({ method: "google", source: AUTO_SOURCE, written: false });
    expect(h.entries).toEqual([]);
  });
  it("several options: stored in the per-site record, refused until the owner chooses, and the options are surfaced", async () => {
    const { h, d } = fakeStore();
    const e = await reject(resolveSignInMethod({ label: L, site: "grok.com", detect: async () => ["email", "x", "google", "email"], now: () => new Date("2026-11-11T12:00:00Z") }, d));
    expect(e).toBeInstanceOf(AccountNotAuthorizedError);
    expect(e!.message).toMatch(/^ACCOUNT_NOT_AUTHORIZED: sign-in method must be chosen: .*grok\.com offers email, x, google/);
    expect(e!.options).toEqual(["email", "x", "google"]);
    expect(h.sites["grok.com"]).toEqual({ site: "grok.com", options: ["email", "x", "google"], detectedAt: "2026-11-11T12:00:00.000Z", source: "detected" });
    expect(h.entries).toEqual([]);
    // the stored record is used next time without detecting again, and is not rewritten
    const again = await reject(resolveSignInMethod({ label: L, site: "grok.com", detect: async () => { throw new Error("not called"); } }, d));
    expect(again!.options).toEqual(["email", "x", "google"]); expect(h.siteWrites).toBe(1);
  });
  it("failed, empty or unknown detection, an unknown site, an unreadable record or a failed write: refused, nothing guessed", async () => {
    for (const detect of [async () => undefined, async () => [], async () => ["email", "microsoft"], async () => { throw new Error("blocked"); }]) {
      const { h, d } = fakeStore();
      const e = await reject(resolveSignInMethod({ label: L, site: "grok.com", detect }, d));
      expect(e).toBeInstanceOf(AccountNotAuthorizedError); expect(e!.message).toMatch(/could not be determined/);
      expect(h.entries).toEqual([]); expect(h.siteWrites).toBe(0);
    }
    expect(await reject(resolveSignInMethod({ label: L, site: "", detect: async () => ["google"] }, fakeStore().d))).toBeInstanceOf(AccountNotAuthorizedError);
    expect((await reject(resolveSignInMethod({ label: L, site: "solo.test", detect: async () => ["google"] }, fakeStore({}, "read").d)))!.message).toMatch(/could not be read/);
    expect((await reject(resolveSignInMethod({ label: L, site: "solo.test", detect: async () => ["google"] }, fakeStore({}, "write").d)))!.message).toMatch(/could not be recorded/);
  });
  it("per-site record notes round-trip; a malformed or misnamed one is not a record", () => {
    const r: SiteOptions = { site: "grok.com", options: ["email", "x"], detectedAt: "2026-11-11T12:00:00.000Z", source: "detected" };
    expect(parseSite("sign-in-options/grok.com", siteNotes(r))).toEqual(r);
    expect(parseSite("sign-in-options/claude.ai", siteNotes(r))).toBeUndefined();
    expect(parseSite("sign-in-options/grok.com", "site=grok.com\noptions=email,fax")).toBeUndefined();
    expect(cleanOptions(["Google", "google"])).toEqual(["google"]);
  });
  it("detectors: accounts.google.com is a fixed single option; marker sites read only their own sign-in page", async () => {
    const data = loadSignInOptions(path.resolve("data", "selectors", "signin-options.json"));
    expect(Object.keys(data.sites).sort()).toEqual(["accounts.google.com", "chatgpt.com", "claude.ai", "grok.com"]);
    expect(await detectSignInOptions(data, "accounts.google.com")).toEqual(["google"]);
    const page = (url: string, hits: string[]) => ({ url: () => url, count: async (q: string) => (hits.some((h) => q.includes(h)) ? 1 : 0) });
    expect(await detectSignInOptions(data, "grok.com", page("https://accounts.x.ai/sign-in", ["input[type=email]", "with google"]))).toEqual(["email", "google"]);
    expect(await detectSignInOptions(data, "grok.com", page("https://evil.example.test/sign-in", ["input[type=email]"]))).toBeUndefined();
    expect(await detectSignInOptions(data, "grok.com", page("https://accounts.x.ai/sign-in", []))).toBeUndefined();
    expect(await detectSignInOptions(data, "grok.com")).toBeUndefined();
    expect(await detectSignInOptions(data, "nowhere.test", page("https://nowhere.test/", ["input"]))).toBeUndefined();
    expect(await detectSignInOptions(data, "grok.com", { url: () => "https://accounts.x.ai/", count: async () => { throw new Error("bad selector"); } })).toBeUndefined();
  });
  it("a flow that performs one kind of sign-in checks the recorded method; registry and entry must agree", () => {
    assertFlowMethod("a Google flow", "google", "google");
    expect(() => assertFlowMethod("a Google flow", "email", "google")).toThrow(AccountMismatchError);
    assertMethodsAgree("grok.com", undefined, "email");
    assertMethodsAgree("grok.com", "email", "email");
    expect(() => assertMethodsAgree("grok.com", "x", "email")).toThrow(AccountMismatchError);
  });
  it("claude.ai sign-in: a Google entry without a method is filled from Google's only option and used", async () => {
    const acc = { id: "second-acct", email: "second@example.test", platforms: ["claude"], signIn: { google: { vaultLabel: "Google second" } } } as unknown as AccountDef;
    const { h, d } = fakeStore();
    const c = await accountCredential(acc, 0, { vault: async () => ({ username: "second@example.test", password: "pw-INVENTED-9" }), signInStore: d.store });
    expect(c.password).toBe("pw-INVENTED-9");
    expect(h.entries).toEqual([{ label: "Google second", method: "google", source: "auto: only option" }]);
  });
});
