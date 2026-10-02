import fs from "node:fs";
import path from "node:path";
import type { Page } from "patchright";
import { guarded } from "../browser/chrome.js";
import { sleep } from "../browser/dom.js";
import { deleteCredential, getCredential, waitForCredential } from "../core/vaultClient.js";
import type { AdapterContext, AdapterOutcome, PlatformAdapter } from "./types.js";

const sel = JSON.parse(fs.readFileSync(path.resolve("data", "selectors", "chatgpt.json"), "utf8"));
const rx = (p: string) => new RegExp(p, "i");

async function signedIn(page: Page): Promise<boolean> {
  const body = (await page.evaluate(() => document.body.innerText.slice(0, 1200)).catch(() => "")).toLowerCase();
  return !(sel.signedOutMarkers as string[]).some((m) => body.includes(m));
}

/**
 * Login: "Continue with Google" (Google is already signed in in the profile; password only if asked), then OpenAI's SMS
 * code. The code is never typed by a human into this process: the operator submits it to a one-time vault entry
 * (vault_request_secret) which is read here, entered, and deleted.
 */
async function login(ctx: AdapterContext): Promise<void> {
  const s = await ctx.session();
  const page = s.page;
  const google = await getCredential(sel.loginVaultLabel);
  const redact = (x: string) => { let o = ctx.redact(x); for (const v of [google?.password, google?.username]) if (v) o = o.split(v).join("<REDACTED>"); return o; };
  await guarded(s, "chatgpt-login", redact, async () => {
    await page.goto(sel.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(2500);
    const popupP = s.context.waitForEvent("page", { timeout: 6000 }).catch(() => null);
    await page.getByRole("button", { name: rx(sel.login.continueWithGoogle) }).first().click();
    const popup = await popupP;
    let cur = popup ?? page;
    await cur.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(3500);
    if (cur.url().includes("accounts.google.com")) {
      if (!google?.password) throw new Error(`Google asked for credentials but vault entry "${sel.loginVaultLabel}" has no password`);
      if (await cur.locator(sel.login.googleEmailInput).count()) {
        await cur.locator(sel.login.googleEmailInput).fill(google.username ?? "");
        await cur.getByRole("button", { name: rx(sel.login.googleNext) }).click();
        await sleep(3500);
      }
      if (await cur.locator(sel.login.googlePasswordInput).count()) {
        await cur.locator(sel.login.googlePasswordInput).first().fill(google.password);
        await cur.getByRole("button", { name: rx(sel.login.googleNext) }).click();
        await sleep(6000);
      }
    }
    cur = s.context.pages().find((p) => /auth\.openai\.com|chatgpt\.com/.test(p.url())) ?? cur;
    if (/mfa-challenge/.test(cur.url()) || (await cur.locator(sel.login.mfaCodeInput).count())) {
      const c = await waitForCredential(sel.smsCodeVaultLabel, sel.smsWaitMinutes * 60 * 1000);
      if (!c) throw new Error(`OpenAI is waiting for an SMS code; timed out after ${sel.smsWaitMinutes} min waiting for vault entry "${sel.smsCodeVaultLabel}" (operator: vault_request_secret with that label)`);
      const code = (c.password || c.username || "").replace(/\D/g, "");
      await cur.locator(sel.login.mfaCodeInput).fill(code);
      await cur.getByRole("button", { name: rx(sel.login.mfaContinue) }).click();
      await deleteCredential(sel.smsCodeVaultLabel).catch(() => {});
      await sleep(7000);
    }
  });
}

async function openPlugins(ctx: AdapterContext): Promise<Page> {
  const s = await ctx.session();
  await s.page.goto(sel.pluginsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(3500);
  if (!(await signedIn(s.page))) {
    await login(ctx);
    await s.page.goto(sel.pluginsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3500);
    if (!(await signedIn(s.page))) throw new Error("chatgpt.com still shows signed out after login");
  }
  return s.page;
}

const pageHasName = async (page: Page, name: string) => (await page.evaluate(() => document.body.innerText)).includes(name);

export function chatgptAdapter(): PlatformAdapter {
  return {
    platform: "chatgpt",
    async probe(ctx) { await openPlugins(ctx); return { status: "ok", detail: "signed in to chatgpt.com" }; },
    async list() { return { names: [] }; },
    async verify(ctx, c): Promise<AdapterOutcome> {
      const page = await openPlugins(ctx);
      return (await pageHasName(page, c.name)) ? { status: "ok", detail: `"${c.name}" appears on the ChatGPT plugins page` } : { status: "error", detail: `"${c.name}" does not appear on the ChatGPT plugins page` };
    },
    async remove() { return { status: "not-implemented", detail: "chatgpt remove not yet mapped (needs a live probe on a throwaway connector)" }; },
    async update() { return { status: "not-implemented", detail: "chatgpt update not yet mapped" }; },
    async add(ctx, c, ifExisting): Promise<AdapterOutcome> {
      const page = await openPlugins(ctx);
      const s = await ctx.session();
      const a = sel.add;
      if (await pageHasName(page, c.name)) {
        if (ifExisting === "skip") return { status: "skipped", detail: `"${c.name}" already on the plugins page` };
        return { status: "error", detail: `"${c.name}" already on the plugins page` };
      }
      const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const r = await guarded(s, "chatgpt-add-" + label, ctx.redact, fn);
        if (process.env.CC_DEBUG) console.error(`[debug chatgpt after ${label}] ` + ctx.redact(await page.evaluate(() => [...document.querySelectorAll("[role=dialog]")].filter((e) => (e as HTMLElement).offsetWidth).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)).join(" || ")).catch(() => "?")));
        return r;
      };
      await g("open-menu", async () => { await page.getByRole("button", { name: rx(a.addButton) }).first().click(); await page.getByRole("menuitem", { name: rx(a.createMcpMenuItem) }).first().waitFor({ timeout: 8000 }); });
      await g("open-form", async () => { await page.getByRole("menuitem", { name: rx(a.createMcpMenuItem) }).first().click(); await page.getByRole("dialog").filter({ hasText: rx(a.dialogHeading) }).first().waitFor({ timeout: 8000 }); });
      const dlg = page.getByRole("dialog").filter({ hasText: rx(a.dialogHeading) }).first();
      await g("fill", async () => {
        await dlg.getByRole("textbox", { name: rx(a.nameTextbox) }).first().fill(c.name);
        if (c.def.description) { const d = dlg.getByRole("textbox", { name: rx(a.descriptionTextbox) }).first(); if (await d.count()) await d.fill(c.def.description); }
        await dlg.getByRole("textbox", { name: rx(a.urlTextbox) }).first().fill(c.url);
      });
      await g("auth", async () => {
        await dlg.getByRole("combobox", { name: rx(a.authCombobox) }).first().click();
        await page.getByRole("option", { name: rx(c.def.auth.mode === "oauth" ? a.oauthOption : a.noAuthOption) }).first().click();
        await dlg.getByRole("checkbox", { name: rx(a.consentCheckbox) }).first().check();
      });
      await g("create", async () => {
        const btn = dlg.getByRole("button", { name: rx(a.createButton) }).first();
        for (let i = 0; i < 45 && (await btn.isDisabled()); i++) {
          const text = await dlg.innerText();
          if (rx(a.failureText).test(text)) throw new Error("ChatGPT rejected the server: " + (text.match(rx(a.failureText))?.[0] ?? "see screenshot"));
          await sleep(1000);
        }
        if (await btn.isDisabled()) throw new Error("Create stayed disabled after server validation");
        await btn.click();
        await sleep(4000);
      });
      await sleep(2000);
      const page2 = await openPlugins(ctx);
      return (await pageHasName(page2, c.name)) ? { status: "ok", detail: `"${c.name}" added (appears on the plugins page)` } : { status: "error", detail: `submitted, but "${c.name}" does not appear on the plugins page` };
    },
  };
}
