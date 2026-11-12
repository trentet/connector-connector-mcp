import fs from "node:fs";
import path from "node:path";
import type { Page } from "patchright";
import { domClick, domFill, sleep } from "../browser/dom.js";
import { guarded, snapshot } from "../browser/chrome.js";
import { assertFlowMethod, assertLoginAccount, assertMethodsAgree, ccMethodErrors } from "../core/accountChoice.js";
import { detectSignInOptions, loadSignInOptions, resolveSignInMethod } from "../core/signInMethod.js";
import { getCredential, signInStore } from "../core/vaultClient.js";
import type { AdapterContext, AdapterOutcome, PlatformAdapter } from "./types.js";

const sel = JSON.parse(fs.readFileSync(path.resolve("data", "selectors", "grok.json"), "utf8"));
const rx = (p: string) => new RegExp(p, "i");

async function dismissCookies(page: Page): Promise<void> {
  const rej = page.getByRole("button", { name: rx(sel.login.rejectCookies.name) });
  if (await rej.count()) { await rej.first().click().catch(() => {}); await sleep(400); }
}

/** Close announcement modals (data: sel.interstitials) that make the page behind inert. Escape first, the dialog's own close button as fallback. Returns how many were closed. */
export async function dismissInterstitials(page: Page): Promise<number> {
  let closed = 0;
  for (const it of (sel.interstitials ?? []) as { dialogText: string; closeButton: string }[]) {
    for (let i = 0; i < 3; i++) {
      const dlg = page.locator("[role=dialog]:visible", { hasText: rx(it.dialogText) }).last();
      if (!(await dlg.count())) break;
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(700);
      if (await dlg.isVisible().catch(() => false)) {
        await dlg.getByRole("button", { name: rx(it.closeButton) }).first().click({ timeout: 5000 }).catch(() => {});
        await sleep(700);
      }
      if (!(await dlg.isVisible().catch(() => false))) { closed++; break; }
    }
  }
  return closed;
}

async function isSignedIn(page: Page): Promise<boolean> {
  // Signed out: the connectors page shows "Sign in" / "Sign up" and no "Toggle Sidebar" account chrome.
  return (await page.getByRole("button", { name: /^sign in$/i }).count()) === 0 && (await page.getByRole("link", { name: /^sign in$/i }).count()) === 0;
}

/**
 * Log in with the vault credential (resolved in this process only). Typed only when the vault entry is exactly the
 * account specified for this run, and an owner registry entry for grok.com agrees (ACCT-C02); otherwise nothing is typed.
 * A signed-in grok.com session is never trusted as it is: the runner verifies it when the session opens (ACCT-C05).
 */
async function login(ctx: AdapterContext): Promise<void> {
  const s = await ctx.session();
  const page = s.page;
  const cred = await getCredential(sel.loginVaultLabel);
  if (!cred?.username || !cred?.password) throw new Error(`vault entry "${sel.loginVaultLabel}" is missing or has no username/password`);
  const recorded = await assertLoginAccount({ service: "grok.com", label: sel.loginVaultLabel, username: cred.username, expected: ctx.account?.email });
  const redact = (x: string) => ctx.redact(x).split(cred.username!).join("<REDACTED>").split(cred.password!).join("<REDACTED>");
  await guarded(s, "grok-login", redact, async () => {
    await page.goto(sel.signInUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(2500);
    await dismissCookies(page);
    // ACCT-C12: the entry's sign-in method (set, else settled from grok.com's options); then a check, not a default:
    // this flow only types into the email-and-password form, so the recorded method must be email.
    const detect = () => detectSignInOptions(loadSignInOptions(path.resolve("data", "selectors", "signin-options.json")), "grok.com", { url: () => page.url(), count: (q) => page.locator(q).count() });
    const { method } = await resolveSignInMethod({ label: sel.loginVaultLabel, site: "grok.com", entryMethod: cred.signInMethod, detect }, { ...ccMethodErrors, store: signInStore });
    assertMethodsAgree("grok.com", recorded, method);
    assertFlowMethod("grok.com's email-and-password login", method, "email");
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
  await dismissInterstitials(s.page);
  if (!(await isSignedIn(s.page))) {
    await login(ctx);
    await s.page.goto(sel.connectorsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3500);
    await dismissCookies(s.page);
    await dismissInterstitials(s.page);
    if (!(await isSignedIn(s.page))) throw new Error("grok.com still shows signed out after login");
  }
  return s.page;
}

/** Grok registers/unregisters asynchronously: poll the Connected list until `name` is present/absent instead of reading once. */
async function waitForState(ctx: AdapterContext, name: string, present: boolean, tries = 5): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await readConnected(ctx)).includes(name) === present) return true;
    await sleep(3000);
  }
  return false;
}

const notMapped = (what: string): AdapterOutcome => ({ status: "not-implemented", detail: `grok ${what} not yet mapped (needs a live probe)` });

/** Names in the "Connected" section: rows are elements whose own text is exactly the marker ("Added"); the row's first line is the name. */
async function readConnected(ctx: AdapterContext): Promise<string[]> {
  const page = await openConnectors(ctx);
  const marker: string = sel.list.rowMarkerText;
  const read = () => page.evaluate((m) => {
    // Rows are <button> (name line + subtitle line); the "Added" tag lives in the row WRAPPER, not inside the button.
    const lines = (e: Element | null) => ((e as HTMLElement | null)?.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const names = new Set<string>();
    for (const b of [...document.querySelectorAll("button")]) {
      const own = lines(b);
      if (!own.length) continue;
      for (let wrap: Element | null = b.parentElement, up = 0; wrap && up < 2; wrap = wrap.parentElement, up++) {
        if (wrap.querySelectorAll("button").length !== 1) break; // wrapper holds several rows: too far up
        if (lines(wrap).includes(m)) { names.add(own[0]); break; }
      }
    }
    return [...names];
  }, marker);
  // The list loads asynchronously: wait until it is non-empty and unchanged for two reads. Never report an empty list as fact.
  let names: string[] = [], stable = 0, last = "";
  for (let i = 0; i < 20 && stable < 2; i++) {
    await sleep(1500);
    names = await read();
    const key = names.slice().sort().join("|");
    stable = names.length > 0 && key === last ? stable + 1 : 0;
    last = key;
  }
  if (stable < 2) throw new Error(`grok.com's Connected list did not finish loading (${names.length} rows seen); refusing to report a partial or empty list`);
  return names;
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
    async remove(ctx, c): Promise<AdapterOutcome> {
      if (!(await readConnected(ctx)).includes(c.name)) return { status: "skipped", detail: `"${c.name}" not in Connected list` };
      const page = await openConnectors(ctx);
      const s = await ctx.session();
      const r = sel.remove;
      const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const res = await guarded(s, "grok-remove-" + label, ctx.redact, fn);
        if (process.env.CC_DEBUG) console.error(`[debug grok remove after ${label}] ` + ctx.redact(await page.evaluate(() => [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter((e) => (e as HTMLElement).offsetWidth).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 90)).join(" || ")).catch(() => "?")));
        return res;
      };
      await g("open-detail", async () => {
        await page.locator("button", { hasText: c.name }).first().click();
        await page.locator("[role=dialog]", { hasText: c.name }).filter({ has: page.getByRole("button", { name: rx(r.disconnectButton) }) }).last().waitFor({ timeout: 10000 });
      });
      await g("disconnect", async () => {
        const detail = page.locator("[role=dialog]", { hasText: c.name }).filter({ has: page.getByRole("button", { name: rx(r.disconnectButton) }) }).last();
        await detail.getByRole("button", { name: rx(r.disconnectButton) }).first().click();
        await sleep(1500);
      });
      await g("confirm", async () => {
        // If a confirmation appears it must name this connector before we confirm.
        const dlg = page.getByRole("alertdialog").last();
        if (await dlg.count()) {
          if (!(await dlg.innerText()).includes(c.name)) throw new Error(`confirmation does not mention "${c.name}"; not confirming`);
          await dlg.getByRole("button", { name: rx(r.confirmButton) }).last().click();
          await sleep(2000);
        }
      });
      const gone = await waitForState(ctx, c.name, false);
      return gone ? { status: "ok", detail: `"${c.name}" removed` } : { status: "error", detail: `clicked Disconnect but "${c.name}" is still in the Connected list` };
    },
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
      await g("open-new-connector", async () => { await dismissInterstitials(page); await page.getByRole("button", { name: rx(a.newConnectorButton) }).first().click(); await dialog.waitFor({ timeout: 10000 }); });
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
      const there = await waitForState(ctx, c.name, true);
      return there ? { status: "ok", detail: `"${c.name}" added (appears in Connected list)` } : { status: "error", detail: `submitted, but "${c.name}" did not appear in grok.com's Connected list after waiting` };
    },
  };
}
