import fs from "node:fs";
import path from "node:path";
import type { Page } from "patchright";
import { domClick, domFill, sleep } from "../browser/dom.js";
import { guarded, snapshot } from "../browser/chrome.js";
import { getCredential } from "../core/vaultClient.js";
import type { AdapterContext, AdapterOutcome, PlatformAdapter } from "./types.js";

const sel = JSON.parse(fs.readFileSync(path.resolve("data", "selectors", "grok.json"), "utf8"));
const rx = (p: string) => new RegExp(p, "i");

async function dismissCookies(page: Page): Promise<void> {
  const rej = page.getByRole("button", { name: rx(sel.login.rejectCookies.name) });
  if (await rej.count()) { await rej.first().click().catch(() => {}); await sleep(400); }
}

async function isSignedIn(page: Page): Promise<boolean> {
  // Signed out: the connectors page shows "Sign in" / "Sign up" and no "Toggle Sidebar" account chrome.
  return (await page.getByRole("button", { name: /^sign in$/i }).count()) === 0 && (await page.getByRole("link", { name: /^sign in$/i }).count()) === 0;
}

/** Log in with the vault credential (resolved in this process only). */
async function login(ctx: AdapterContext): Promise<void> {
  const s = await ctx.session();
  const page = s.page;
  const cred = await getCredential(sel.loginVaultLabel);
  if (!cred?.username || !cred?.password) throw new Error(`vault entry "${sel.loginVaultLabel}" is missing or has no username/password`);
  const redact = (x: string) => ctx.redact(x).split(cred.username!).join("<REDACTED>").split(cred.password!).join("<REDACTED>");
  await guarded(s, "grok-login", redact, async () => {
    await page.goto(sel.signInUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(2500);
    await dismissCookies(page);
    await page.locator(sel.login.emailInput).fill(cred.username!);
    await page.getByRole("button", { name: rx(sel.login.next.name) }).first().click();
    await page.locator(sel.login.passwordInput).first().waitFor({ timeout: 15000 });
    await page.locator(sel.login.passwordInput).first().fill(cred.password!);
    await page.getByRole("button", { name: rx(sel.login.submit.name) }).first().click();
    await page.waitForURL(/accounts\.x\.ai\/account|grok\.com/, { timeout: 20000 });
  });
}

async function openConnectors(ctx: AdapterContext): Promise<Page> {
  const s = await ctx.session();
  await s.page.goto(sel.connectorsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(3500);
  await dismissCookies(s.page);
  if (!(await isSignedIn(s.page))) {
    await login(ctx);
    await s.page.goto(sel.connectorsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3500);
    await dismissCookies(s.page);
    if (!(await isSignedIn(s.page))) throw new Error("grok.com still shows signed out after login");
  }
  return s.page;
}

const notMapped = (what: string): AdapterOutcome => ({ status: "not-implemented", detail: `grok ${what} not yet mapped (needs a live probe)` });

export function grokAdapter(): PlatformAdapter {
  return {
    platform: "grok",
    async probe(ctx) { await openConnectors(ctx); return { status: "ok", detail: "signed in to grok.com" }; },
    async list() { return { names: [] }; },
    async verify() { return notMapped("verify/list"); },
    async remove() { return notMapped("remove"); },
    async update() { return notMapped("update"); },
    async add(ctx, c, _ifExisting): Promise<AdapterOutcome> {
      const page = await openConnectors(ctx);
      const s = await ctx.session();
      const a = sel.add;
      const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const r = await guarded(s, "grok-add-" + label, ctx.redact, fn);
        if (process.env.CC_DEBUG) console.error(`[debug grok after ${label}] ` + JSON.stringify(await snapshot(page, ctx.redact, { containing: a.dialogMarkerInput, up: 6 }).catch((e) => ({ err: String(e) }))));
        return r;
      };
      await g("open-new-connector", async () => { await page.getByRole("button", { name: rx(a.newConnectorButton) }).first().click(); await sleep(1500); });
      await g("choose-custom", async () => { await domClick(page.getByRole("button", { name: rx(a.customTile) }).or(page.getByText(rx(a.customTile))).first()); await sleep(1200); });
      await g("fill", async () => {
        await domFill(page.locator(`input[placeholder="${a.namePlaceholder}"]`), c.name);
        await domFill(page.locator(`input[placeholder*="${a.urlPlaceholder}"]`), c.url);
        await sleep(600);
      });
      await g("submit", async () => { await domClick(page.getByRole("button", { name: rx(a.submitButton) }).first()); await sleep(5000); });
      return { status: "ok", detail: `submitted "${c.name}" to grok.com (not yet verified: list/verify not mapped)` };
    },
  };
}
