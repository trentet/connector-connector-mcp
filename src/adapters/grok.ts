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

/** Names in the "Connected" section: rows are elements whose own text is exactly the marker ("Added"); the row's first line is the name. */
async function readConnected(ctx: AdapterContext): Promise<string[]> {
  const page = await openConnectors(ctx);
  const marker: string = sel.list.rowMarkerText;
  await sleep(1500);
  return page.evaluate((m) => {
    const names = new Set<string>();
    for (const leaf of [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() === m)) {
      let row: Element | null = leaf.parentElement;
      for (let i = 0; i < 4 && row; i++) {
        const lines = ((row as HTMLElement).innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length >= 2 && lines.indexOf(m) > 0) { names.add(lines[0]); break; }
        row = row.parentElement;
      }
    }
    return [...names];
  }, marker);
}

export function grokAdapter(): PlatformAdapter {
  return {
    platform: "grok",
    async probe(ctx) { await openConnectors(ctx); return { status: "ok", detail: "signed in to grok.com" }; },
    async list(ctx) { return { names: await readConnected(ctx) }; },
    async verify(ctx, c): Promise<AdapterOutcome> {
      const names = await readConnected(ctx);
      return names.includes(c.name) ? { status: "ok", detail: `"${c.name}" is in grok.com's Connected list` } : { status: "error", detail: `"${c.name}" is not in grok.com's Connected list (${names.length} connectors listed)` };
    },
    async remove() { return notMapped("remove"); },
    async update() { return notMapped("update"); },
    async add(ctx, c, ifExisting): Promise<AdapterOutcome> {
      const existing = (await readConnected(ctx)).includes(c.name);
      if (existing) {
        if (ifExisting === "skip") return { status: "skipped", detail: `"${c.name}" already in Connected list` };
        if (ifExisting === "fail") return { status: "error", detail: `"${c.name}" already in Connected list` };
        return notMapped("update (remove-then-add)");
      }
      const page = await openConnectors(ctx);
      const s = await ctx.session();
      const a = sel.add;
      const dialog = page.locator(a.dialog).last();
      const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const r = await guarded(s, "grok-add-" + label, ctx.redact, fn);
        if (process.env.CC_DEBUG) console.error(`[debug grok after ${label}] ` + ctx.redact(await page.evaluate(() => { const d = [...document.querySelectorAll("[role=dialog]")].pop(); return d ? (d as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200) : "(no dialog)"; }).catch(() => "?")));
        return r;
      };
      await g("open-new-connector", async () => { await page.getByRole("button", { name: rx(a.newConnectorButton) }).first().click(); await dialog.waitFor({ timeout: 10000 }); });
      // The Custom tile is a button INSIDE the dialog; the page has other "Custom" text that a global text match would hit first.
      await g("choose-custom", async () => { await dialog.getByRole("button", { name: rx(a.customTile) }).first().click(); await dialog.getByText(rx(a.formHeading)).first().waitFor({ timeout: 8000 }); });
      await g("fill", async () => {
        const nameBox = dialog.locator(`input[placeholder="${a.namePlaceholder}"]`);
        const urlBox = dialog.locator(`input[placeholder*="${a.urlPlaceholder}"]`);
        await nameBox.click(); await nameBox.pressSequentially(c.name, { delay: 12 });
        await urlBox.click(); await urlBox.pressSequentially(c.url, { delay: 4 });
      });
      await g("submit", async () => {
        const btn = dialog.getByRole("button", { name: rx(a.submitButton) }).first();
        for (let i = 0; i < 20 && (await btn.isDisabled()); i++) await sleep(300);
        if (await btn.isDisabled()) throw new Error("Add Connector stayed disabled after filling name and URL");
        await btn.click();
        await sleep(4000);
      });
      const names = await readConnected(ctx);
      return names.includes(c.name) ? { status: "ok", detail: `"${c.name}" added (appears in Connected list)` } : { status: "error", detail: `submitted, but "${c.name}" did not appear in grok.com's Connected list` };
    },
  };
}
