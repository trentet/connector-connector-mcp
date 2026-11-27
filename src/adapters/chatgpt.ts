import fs from "node:fs";
import path from "node:path";
import type { Page } from "patchright";
import { guarded } from "../browser/chrome.js";
import { sleep } from "../browser/dom.js";
import { deleteCredential, getCredential, signInStore, waitForCredential } from "../core/vaultClient.js";
import { detectSignInOptions, loadSignInOptions, resolveSignInMethod } from "../core/signInMethod.js";
import * as acctRule from "../core/accountChoice.js";
import type { AdapterContext, AdapterOutcome, PlatformAdapter } from "./types.js";
import { requestChatgptRefresh } from "./chatgptRefresh.js";

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
      // ACCT-C12: the entry's sign-in method (set, else settled from accounts.google.com's options), then a check, not
      // a default: this flow signs in through "Continue with Google", so the recorded method must be google.
      const { method } = await resolveSignInMethod({ label: sel.loginVaultLabel, site: "accounts.google.com", entryMethod: google.signInMethod, detect: async () => detectSignInOptions(loadSignInOptions(path.resolve("data", "selectors", "signin-options.json")), "accounts.google.com") }, { ...acctRule.ccMethodErrors, store: signInStore });
      acctRule.assertFlowMethod("chatgpt.com's Continue with Google login", method, "google");
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

async function openPlugins(ctx: AdapterContext, allowLogin = true): Promise<Page> {
  const s = await ctx.session();
  await s.page.goto(sel.pluginsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(3500);
  if (!(await signedIn(s.page))) {
    if (!allowLogin) throw new Error("ChatGPT is signed out; metadata refresh needs an authenticated session and will not initiate login or SMS verification");
    await login(ctx);
    await s.page.goto(sel.pluginsUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(3500);
    if (!(await signedIn(s.page))) throw new Error("chatgpt.com still shows signed out after login");
  }
  return s.page;
}

/** Names in the "Installed" section of the plugins page (item text's first line). */
async function readInstalled(ctx: AdapterContext): Promise<string[]> {
  const page = await openPlugins(ctx);
  const heading: string = sel.list.installedHeading;
  await page.waitForFunction((h) => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => (e as HTMLElement).innerText.trim() === h), heading, { timeout: 20000, polling: 500 }).catch(() => {});
  await sleep(1500);
  return page.evaluate((h) => {
    const hd = [...document.querySelectorAll("h1,h2,h3,[role=heading]")].find((e) => (e as HTMLElement).innerText.trim() === h);
    if (!hd) return [];
    const sec = hd.closest("section") ?? hd.parentElement?.parentElement;
    const names = new Set<string>();
    for (const e of [...(sec?.querySelectorAll("button,a,li,[role=listitem]") ?? [])]) {
      const first = ((e as HTMLElement).innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0];
      if (first && first !== h && first.length < 80) names.add(first);
    }
    return [...names];
  }, heading);
}
/** Opens the plugin's own page from the Installed list and checks the heading, so nothing is clicked on the wrong plugin. */
async function openPluginPage(ctx: AdapterContext, name: string, allowLogin = true): Promise<Page> {
  const page = await openPlugins(ctx, allowLogin);
  await page.locator("section a", { hasText: new RegExp("^\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$") }).first().click();
  await page.waitForURL(/\/plugins\/[^/]+/, { timeout: 15000 });
  const onPage = await page.waitForFunction((n) => ((document.querySelector("main") as HTMLElement | null)?.innerText ?? "").split("\n").some((l) => l.trim() === n), name, { timeout: 12000, polling: 500 }).then(() => true, () => false);
  if (!onPage) throw new Error(`opened a plugin page that never showed "${name}" as a title`);
  return page;
}

type ConnectionState = "connected" | "not-connected" | "unreadable";
/**
 * Connection state on a plugin's own page: a "Connected" label when ChatGPT completed its handshake with the server,
 * a "Connect" button when the app is installed but not connected. The page lists no discovered tools, so this is the deepest check available.
 */
/** Visible text of the app page the last time its connection state was read; surfaced when the state is unreadable so UI drift can be fixed from the real wording. */
let lastPageLines: string[] = [];
const pageSnippet = () => lastPageLines.slice(0, 30).join(" | ").slice(0, 600);

async function pageConnectionState(page: Page): Promise<ConnectionState> {
  const connected = new RegExp(sel.verify.connectedLabel, "i"), connect = new RegExp(sel.verify.connectLabel, "i"), ready = new RegExp(sel.verify.readyLabel, "i");
  for (let i = 0; i < 6; i++) {
    const lines: string[] = await page.evaluate(() => ((document.querySelector("main") as HTMLElement | null)?.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
    lastPageLines = lines;
    if (lines.some((l) => connected.test(l))) return "connected";
    if (lines.some((l) => connect.test(l))) return "not-connected";
    // An OAuth app that has finished its sign-in shows no "Connected" label, only "Try in chat" (seen live 2026-10-02, with the server log showing the token exchange). Checked after "Connect" so an unconnected app that also offers "Try in chat" is not misread.
    if (lines.some((l) => ready.test(l))) return "connected";
    await sleep(1500);
  }
  return "unreadable";
}
const readConnectionState = async (ctx: AdapterContext, name: string) => pageConnectionState(await openPluginPage(ctx, name));

/** An installed app still needs ChatGPT's own Connect step (button, then a confirmation dialog) before chats can use it. Idempotent. */
async function ensureConnected(ctx: AdapterContext, name: string): Promise<"already" | "connected-now"> {
  const page = await openPluginPage(ctx, name);
  const state = await pageConnectionState(page);
  if (state === "connected") return "already";
  if (state === "unreadable") throw new Error(`"${name}" page shows neither Connected nor Connect. Page text: ${pageSnippet()}`);
  await page.getByRole("button", { name: new RegExp(sel.verify.connectLabel, "i") }).first().click();
  const dlg = page.getByRole("dialog").or(page.getByRole("alertdialog")).filter({ hasText: name }).last();
  await dlg.waitFor({ timeout: 12000 }).catch(() => { throw new Error(`no connect dialog naming "${name}" appeared; not confirming`); });
  await dlg.getByRole("button", { name: new RegExp(sel.verify.connectConfirm, "i") }).last().click();
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    if ((await pageConnectionState(page)) === "connected") return "connected-now";
  }
  throw new Error(`clicked Connect for "${name}" but its page never showed Connected`);
}
const pageHasName = async (ctx: AdapterContext, name: string) => (await readInstalled(ctx)).includes(name);

export function chatgptAdapter(): PlatformAdapter {
  return {
    platform: "chatgpt",
    async probe(ctx) { await openPlugins(ctx); return { status: "ok", detail: "signed in to chatgpt.com" }; },
    async list(ctx) { return { names: await readInstalled(ctx) }; },
    async verify(ctx, c): Promise<AdapterOutcome> {
      if (!(await pageHasName(ctx, c.name))) return { status: "error", detail: `"${c.name}" is not in ChatGPT's Installed list` };
      const state = await readConnectionState(ctx, c.name);
      if (state === "connected") return { status: "ok", detail: `"${c.name}" is Installed and its page shows Connected (ChatGPT shows no tool list, so discovered tools are not checked)` };
      if (state === "not-connected") return { status: "error", detail: `"${c.name}" is Installed but its page shows Connect, i.e. ChatGPT has not connected to the server` };
      return { status: "error", detail: `"${c.name}" is Installed but its page shows neither Connected nor Connect (UI drift? check data/selectors/chatgpt.json "verify"). Page text: ${pageSnippet()}` };
    },
    async remove(ctx, c): Promise<AdapterOutcome> {
      if (!(await pageHasName(ctx, c.name))) return { status: "skipped", detail: `"${c.name}" not in Installed list` };
      const page = await openPlugins(ctx);
      const s = await ctx.session();
      const r = sel.remove;
      const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const res = await guarded(s, "chatgpt-remove-" + label, ctx.redact, fn);
        if (process.env.CC_DEBUG) console.error(`[debug chatgpt remove after ${label}] ` + ctx.redact(await page.evaluate(() => `${location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "<id>")} | ` + [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter((e) => (e as HTMLElement).offsetWidth).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 120)).join(" || ")).catch(() => "?")));
        return res;
      };
      await g("open-plugin-page", async () => {
        await page.locator("section a", { hasText: new RegExp("^\\s*" + c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$") }).first().click();
        await page.waitForURL(/\/plugins\/[^/]+/, { timeout: 15000 });
        await sleep(2000);
        const h1 = (await page.locator("h1").first().innerText().catch(() => "")).trim();
        if (h1 !== c.name) throw new Error(`opened a page headed "${h1}", expected "${c.name}"; not deleting`);
      });
      await g("open-menu", async () => { await page.locator(r.moreActions).last().click(); await sleep(800); });
      await g("click-delete", async () => { await page.getByRole("menuitem", { name: rx(r.deleteItem) }).first().click(); await sleep(1200); });
      await g("confirm", async () => {
        const dlg = page.getByRole("alertdialog").or(page.getByRole("dialog")).last();
        await dlg.waitFor({ timeout: 8000 });
        if (!(await dlg.innerText()).includes(c.name)) throw new Error(`confirmation does not mention "${c.name}"; not confirming`);
        await dlg.getByRole("button", { name: rx(r.confirmButton) }).last().click();
        await sleep(3000);
      });
      for (let i = 0; i < 5; i++) { if (!(await pageHasName(ctx, c.name))) return { status: "ok", detail: `"${c.name}" deleted` }; await sleep(3000); }
      return { status: "error", detail: `confirmed delete but "${c.name}" is still in the Installed list` };
    },
    async update(ctx, c): Promise<AdapterOutcome> {
      // Refs issue #83. Refresh ONLY the existing app's metadata; do not delete,
      // reinstall, sign in or alter endpoint/authentication configuration.
      const s = await ctx.session();
      const page = await guarded(s, "chatgpt-refresh-open-plugin", ctx.redact, () => openPluginPage(ctx, c.name, false));
      const before = await pageConnectionState(page);
      if (before !== "connected") {
        return { status: "error", detail: "Plugin must be Connected before metadata refresh; state is " + before };
      }
      const route = await guarded(s, "chatgpt-refresh-metadata", ctx.redact, () =>
        requestChatgptRefresh(page, sel.refresh)
      );
      await sleep(1500);
      const after = await pageConnectionState(page);
      if (after !== "connected") {
        return { status: "error", detail: "Refresh control was clicked (" + route + ") but plugin is not confirmed Connected afterward (" + after + ")" };
      }
      // The Installed details view does not establish what inputSchema ChatGPT
      // has approved. A new ChatGPT conversation must read browser_open_session
      // and verify that the mandatory headless boolean is exposed before claiming
      // the connector is fixed.
      return { status: "skipped", detail: "Refresh control clicked (" + route + ") and plugin remains Connected. Tool schema not verified; open a new ChatGPT conversation and verify the required input fields before claiming success." };
    },
    async add(ctx, c, ifExisting): Promise<AdapterOutcome> {
      const page = await openPlugins(ctx);
      const s = await ctx.session();
      const a = sel.add;
      if (await pageHasName(ctx, c.name)) {
        if (ifExisting !== "skip") return { status: "error", detail: `"${c.name}" already installed` };
        const was = await ensureConnected(ctx, c.name);
        return was === "already" ? { status: "skipped", detail: `"${c.name}" already installed and Connected` } : { status: "ok", detail: `"${c.name}" was installed but not connected; clicked Connect, page now shows Connected` };
      }
      const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const r = await guarded(s, "chatgpt-add-" + label, ctx.redact, fn);
        if (process.env.CC_DEBUG) console.error(`[debug chatgpt after ${label}] ` + ctx.redact(await page.evaluate(() => [...document.querySelectorAll("[role=dialog]")].filter((e) => (e as HTMLElement).offsetWidth).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 200)).join(" || ")).catch(() => "?")));
        return r;
      };
      await g("open-menu", async () => { const addBtn = page.getByRole("button", { name: rx(a.addButton) }).first(); await addBtn.waitFor({ timeout: 20000 }); await addBtn.click(); await page.getByRole("menuitem", { name: rx(a.createMcpMenuItem) }).first().waitFor({ timeout: 8000 }); });
      await g("open-form", async () => { await page.getByRole("menuitem", { name: rx(a.createMcpMenuItem) }).first().click(); await page.getByRole("dialog").filter({ hasText: rx(a.dialogHeading) }).first().waitFor({ timeout: 8000 }); });
      const dlg = page.getByRole("dialog").filter({ hasText: rx(a.dialogHeading) }).first();
      await g("fill", async () => {
        await dlg.getByRole("textbox", { name: rx(a.nameTextbox) }).first().fill(c.name);
        if (c.def.description) { const d = dlg.getByRole("textbox", { name: rx(a.descriptionTextbox) }).first(); if (await d.count()) await d.fill(c.def.description); }
        await dlg.getByRole("textbox", { name: rx(a.urlTextbox) }).first().fill(c.url);
      });
      await g("auth", async () => {
        // Authentication is a native <select> (OAuth / No authentication / OAuth or no authentication).
        await dlg.locator(a.authSelect).first().selectOption({ label: c.def.auth.mode === "oauth" ? a.oauthLabel : a.noAuthLabel });
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
      for (let i = 0; i < 5; i++) { if (await pageHasName(ctx, c.name)) { await ensureConnected(ctx, c.name); return { status: "ok", detail: `"${c.name}" added, appears in Installed list, and page shows Connected` }; } await sleep(3000); }
      return { status: "error", detail: `submitted, but "${c.name}" did not appear in ChatGPT's Installed list after waiting` };
    },
  };
}
