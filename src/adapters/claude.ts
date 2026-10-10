import fs from "node:fs";
import path from "node:path";
import type { Page } from "patchright";
import { domClick, domFill, sleep } from "../browser/dom.js";
import { guarded, snapshot } from "../browser/chrome.js";
import type { AdapterContext, AdapterOutcome, PlatformAdapter, ResolvedConnector } from "./types.js";

const sel = JSON.parse(fs.readFileSync(path.resolve("data", "selectors", "claude.json"), "utf8"));
const rx = (p: string) => new RegExp(p, "i");

export class DuplicateUrlError extends Error {}

const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
/** True when `text` mentions `name`, ignoring case, spaces and punctuation. Exported for tests. */
export const sameName = (text: string, name: string) => squash(text).includes(squash(name));

export interface Row { name: string; custom: boolean; connected: boolean; /** Raw status text when it is neither "Connected" nor "Connect" (e.g. a re-authorise state), so the row is still found and can be removed. */ status?: string }

/** Parse the connector table text ("Name Web [Custom] Connected|Connect"). */
export function parseRow(text: string): Row | undefined {
  // claude.ai renders icons from a private-use font (U+E000-F8FF) inside the row text; they are not whitespace.
  const t = text.replace(/[\uE000-\uF8FF\u200B-\u200D\u2060\uFEFF]/g, " ").trim().replace(/\s+/g, " ");
  if (!t || /^connector type status$/i.test(t)) return undefined;
  const m = /^(.*?)\s+Web\b(\s+Custom)?\s*(.*)$/i.exec(t);
  if (!m) return undefined;
  const status = (m[3] ?? "").trim();
  const row: Row = { name: m[1].trim(), custom: !!m[2], connected: /^connected$/i.test(status) };
  if (status && !/^(connected|connect)$/i.test(status)) row.status = status;
  return row;
}

async function assertSignedIn(page: Page): Promise<void> {
  const u = page.url();
  const body = (await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => "")).toLowerCase();
  if (/\/login|\/logout/.test(u) || (sel.signedOutMarkers as string[]).some((m) => body.includes(m) && !body.includes("customize"))) {
    throw new Error("claude.ai is not signed in (automatic Google login for claude.ai is not implemented yet)");
  }
}

/** The table fills in progressively; wait until the row count is stable, and refuse to report a partial list. */
async function readRows(ctx: AdapterContext): Promise<Row[]> {
  const s = await ctx.session();
  await s.page.goto(sel.listUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await s.page.waitForSelector(sel.listRow, { timeout: 20000 }).catch(() => {});
  await assertSignedIn(s.page);
  let texts: string[] = [];
  let stable = 0, last = -1;
  for (let i = 0; i < 40 && stable < 3; i++) {
    texts = await s.page.$$eval(sel.listRow, (rs) => rs.map((r) => (r as HTMLElement).innerText));
    stable = texts.length === last && texts.length > 1 ? stable + 1 : 0;
    last = texts.length;
    await sleep(800);
  }
  if (stable < 3) throw new Error(`connector list did not finish loading (${texts.length} rows seen); refusing to report a partial list`);
  return texts.map(parseRow).filter((r): r is Row => !!r);
}

async function doAdd(ctx: AdapterContext, c: ResolvedConnector): Promise<void> {
  const s = await ctx.session();
  const page = s.page;
  const a = sel.add;
  const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const r = await guarded(s, "claude-add-" + label, ctx.redact, fn);
    // Opt-in diagnostics (CC_DEBUG=1): redacted, dialog-scoped snapshot after every step, to stderr.
    if (process.env.CC_DEBUG) console.error(`[debug after ${label}] ` + JSON.stringify(await snapshot(page, ctx.redact, { containing: "[role=dialog]", up: 0 }).catch((e) => ({ snapshotError: String(e) }))));
    return r;
  };

  await g("open-dialog", async () => {
    await page.goto(sel.addUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await assertSignedIn(page);
    await page.getByRole("heading", { name: rx(a.dialogHeading) }).or(page.getByText(rx(a.dialogHeading))).first().waitFor({ timeout: 15000 });
  });
  await g("fill-name", () => domFill(page.getByPlaceholder(rx(a.namePlaceholder)), c.name));
  await g("fill-url", () => domFill(page.getByPlaceholder(rx(a.urlPlaceholder)), c.url));
  await g("continue", async () => {
    await domClick(page.getByRole("button", { name: rx(a.continueButton) }).first());
    await sleep(2500);
  });
  await g("check-duplicate-url", async () => {
    // claude.ai refuses a second connector with the same URL ("already exists in your organization").
    const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    if (body.includes(a.duplicateUrlText)) throw new DuplicateUrlError(`claude.ai says a connector with this URL already exists in your organization; "${c.name}" was not added. Use the existing connector or give this one a distinct URL.`);
  });
  await g("dismiss-server-warning", async () => {
    // A failed live check overlays the dialog with "Continue anyway"; it would cover the header controls.
    const w = page.getByText(rx(a.serverWarningContinue)).first();
    if (await w.count()) { await domClick(w); await sleep(1000); }
  });
  if (c.def.auth.mode !== "oauth") {
    await g("select-no-sign-in", async () => {
      // Default is "Sign in now" (OAuth); a header/URL-token server must use "No sign-in" or nothing gets created.
      await domClick(page.getByRole("radio", { name: rx(a.noSignInRadio) }).or(page.getByText(rx("^" + a.noSignInRadio + "$"))).first());
      await sleep(600);
    });
  }
  if (c.def.auth.mode === "header" && c.headerValue && c.def.auth.headerName) {
    const headerName = c.def.auth.headerName;
    const headerValue = c.headerValue;
    await g("add-header", async () => {
      await domClick(page.getByText(rx(a.addHeaderText)).first());
      await sleep(800);
      const nameField = page.getByRole("combobox", { name: rx(a.headerNameCombobox) }).or(page.getByRole("textbox", { name: rx(a.headerNameCombobox) })).or(page.getByPlaceholder(rx("^" + a.headerNameCombobox + "$"))).first();
      await domClick(nameField);
      await nameField.pressSequentially(headerName, { delay: 20 });
      const opt = page.getByRole("option", { name: headerName, exact: true }).first();
      if (await opt.count()) await domClick(opt); else await page.keyboard.press("Enter");
      await sleep(400);
      const valueField = page.getByRole("textbox", { name: rx(a.headerValueTextbox) }).or(page.getByPlaceholder(rx(a.headerValueTextbox))).first();
      await domFill(valueField, headerValue);
      if (await page.getByText(/choose a header name/i).count()) throw new Error("header name was not accepted");
    });
  }
  await g("final-submit", async () => {
    await domClick(page.getByRole("button", { name: rx(a.finalSubmit) }).last());
    await sleep(3000);
  });
}

async function connectIfNeeded(ctx: AdapterContext, name: string): Promise<Row | undefined> {
  const s = await ctx.session();
  await s.page.goto(sel.listUrl, { waitUntil: "domcontentloaded" });
  await s.page.waitForSelector(sel.listRow, { timeout: 20000 }).catch(() => {});
  // Same substring-match hazard as remove() (fixed above): hasText on a plain string matches
  // "name" as a prefix too, so this must resolve the exact row by parsed name, not loose hasText.
  const rowTexts = await s.page.$$eval(sel.listRow, (rs) => rs.map((r) => (r as HTMLElement).innerText));
  const rowIndex = rowTexts.findIndex((t) => parseRow(t)?.name === name);
  if (rowIndex >= 0) {
    const row = s.page.locator(sel.listRow).nth(rowIndex);
    const btn = row.getByRole("button", { name: rx(sel.add.rowConnectButton) });
    if (await btn.count()) { await domClick(btn.first()); await sleep(5000); }
  }
  return (await readRows(ctx)).find((r) => r.name === name);
}

export function claudeAdapter(): PlatformAdapter {
  const find = async (ctx: AdapterContext, name: string) => (await readRows(ctx)).find((r) => r.name === name);
  return {
    platform: "claude",
    async list(ctx) { return { names: (await readRows(ctx)).map((r) => r.name + (r.custom ? " (custom)" : "") + (r.connected ? "" : r.status ? ` [not connected: ${r.status}]` : " [not connected]")) }; },
    async probe(ctx) { const rows = await readRows(ctx); return { status: "ok", detail: `signed in; ${rows.length} connectors listed` }; },
    async verify(ctx, c): Promise<AdapterOutcome> {
      const r = await find(ctx, c.name);
      if (!r) return { status: "error", detail: `"${c.name}" is not registered on claude.ai` };
      return r.connected ? { status: "ok", detail: `"${c.name}" registered and Connected` } : { status: "error", detail: `"${c.name}" is registered but not Connected` };
    },
    async add(ctx, c, ifExisting): Promise<AdapterOutcome> {
      const existing = await find(ctx, c.name);
      if (existing) {
        if (ifExisting === "skip") return { status: "skipped", detail: `"${c.name}" already registered` };
        if (ifExisting === "fail") return { status: "error", detail: `"${c.name}" already registered` };
        const rm = await this.remove(ctx, c);
        if (rm.status === "error" || rm.status === "not-implemented") return rm;
      }
      try { await doAdd(ctx, c); } catch (e) { if (/connector with this URL already exists/.test((e as Error).message)) return { status: "error", detail: (e as Error).message.replace(/^claude-add-check-duplicate-url failed: /, "").replace(/ \(screenshot:.*$/, "") }; throw e; }
      const row = await connectIfNeeded(ctx, c.name);
      if (!row) return { status: "error", detail: `submitted, but "${c.name}" did not appear in the list` };
      return row.connected ? { status: "ok", detail: `"${c.name}" added and Connected` } : { status: "error", detail: `"${c.name}" added but not Connected` };
    },
    async update(ctx, c) { return this.add(ctx, c, "update"); },
    async remove(ctx, c): Promise<AdapterOutcome> {
      const row = await find(ctx, c.name);
      if (!row) return { status: "skipped", detail: `"${c.name}" not registered` };
      const s = await ctx.session();
      const page = s.page;
      const r = sel.remove;
      const g = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        const res = await guarded(s, "claude-remove-" + label, ctx.redact, fn);
        if (process.env.CC_DEBUG) console.error(`[debug remove after ${label}] ` + JSON.stringify(await page.evaluate(() => ({ url: location.pathname.replace(/[0-9a-f-]{36}/, "<id>"), dialogs: [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].map((d) => ({ role: d.getAttribute("role"), text: (d as HTMLElement).innerText.replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").slice(0, 300), buttons: [...d.querySelectorAll("button")].map((b) => b.innerText.trim().replace(/\s+/g, " ")) })) })).then((x) => JSON.parse(ctx.redact(JSON.stringify(x)))).catch((e) => ({ err: String(e) }))));
        return res;
      };
      await g("open-detail", async () => {
        await page.goto(sel.listUrl, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(sel.listRow, { timeout: 20000 });
        // hasText on a plain string is a SUBSTRING match - unsafe whenever one connector's name is a
        // prefix of another's (e.g. a production connector's name vs. its own "... TEST" tier
        // variant): it would pick whichever row DOM order puts first, regardless of which one was
        // asked for, and could delete the wrong connector outright. Confirmed live 2026-10-02: this
        // exact collision deleted a TEST-tier connector while trying to repair its production
        // counterpart. Use the same exact-name match parseRow()/find() already use elsewhere in this
        // file instead.
        const rowTexts = await page.$$eval(sel.listRow, (rs) => rs.map((r) => (r as HTMLElement).innerText));
        const rowIndex = rowTexts.findIndex((t) => parseRow(t)?.name === c.name);
        if (rowIndex < 0) throw new Error(`row for "${c.name}" not found (listed ${rowTexts.length} rows)`);
        const tr = page.locator(sel.listRow).nth(rowIndex);
        await tr.click();
        await page.waitForURL(/\/yours\/id\//, { timeout: 15000 });
        await sleep(1500);
        // guard against clicking the wrong connector's detail page
        const heading = (await page.locator("main").innerText()).replace(/[\uE000-\uF8FF]/g, " ");
        // Case/punctuation-insensitive: a connector in an error state can show the server's own name instead of the display name.
        // The row was already picked by exact name above, so this is only a second guard against a mis-click.
        // An errored connector's page shows its URL instead of its name (seen live): accept the connector's own host as well (host only, never the query).
        let host = ""; try { host = new URL(c.url).host.toLowerCase(); } catch { /* keep empty */ }
        if (!sameName(heading, c.name) && !(host && heading.toLowerCase().includes(host))) throw new Error(`opened a detail page that does not mention "${c.name}". Page text: ${heading.replace(/\s+/g, " ").slice(0, 300)}`);
      });
      await g("open-menu", async () => { await page.locator("main").getByRole("button", { name: rx(r.moreButton) }).first().click(); await sleep(800); });
      await g("click-remove", async () => { await page.getByRole("menuitem", { name: rx(r.removeMenuItem) }).first().click(); await sleep(1200); });
      await g("confirm", async () => {
        // Remove opens an ALERTDIALOG ("Remove <name>? ..." with Cancel / Remove), not a plain dialog.
        const dlg = page.getByRole("alertdialog").or(page.getByRole("dialog")).last();
        await dlg.waitFor({ timeout: 8000 });
        const text = (await dlg.innerText()).replace(/[\uE000-\uF8FF]/g, " ");
        if (!text.includes(c.name)) throw new Error(`confirmation dialog does not mention "${c.name}"; not confirming`);
        await domClick(dlg.getByRole("button", { name: rx(r.confirmButton) }).last());
        await sleep(2500);
      });
      const gone = !(await find(ctx, c.name));
      return gone ? { status: "ok", detail: `"${c.name}" removed` } : { status: "error", detail: `clicked Remove but "${c.name}" is still listed` };
    },
  };
}
