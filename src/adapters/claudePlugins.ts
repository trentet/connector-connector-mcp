import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "patchright";
import { sleep } from "../browser/dom.js";
import { BlockedError, safeUrl } from "./claudeSettings.js";
import type { InstalledPlugin, PluginsPage } from "../core/plugins.js";

export { BlockedError } from "./claudeSettings.js"; // the plugins CLI block resolves BlockedError from this adapter, mirroring settings

/**
 * Page logic for `cc plugins` on claude.ai (Customize -> Plugins): read the account's plugins, add a marketplace, add/enable
 * the declared HELM AMS gate plugins. Facts about the page (URLs, selectors, waits) are data in
 * data/selectors/claude-plugins.json; a UI change is fixed there. Implements AGM-DEPLOY-001 (trentet/helm-agent-management).
 *
 * Bounds (cc engineering default, enforced HERE in code so no selector edit can widen them): clicks happen only through
 * `guardedClick`, only on the configured claude.ai hosts, only for the five add/enable roles below, and never on a control
 * whose name matches PLUGIN_CLICK_DENY. It only ADDS a marketplace and ADDS/ENABLES the declared gates. It never removes,
 * disables, uninstalls, renames or reorders any plugin, never touches another marketplace, a connector, memory, preferences,
 * billing or sign-in. An already-enabled gate is never clicked (idempotent at the driver, not just the orchestration).
 */

export interface PluginsTiming { pageMs: number; elementMs: number; listStableChecks: number; pollMs: number; settleMs: number }
export interface PluginsSpec {
  hosts: string[]; pluginsUrl: string;
  /** Each plugin on the "Yours" tab. */ pluginRow: string; pluginName: string; /** enabled when this matches inside the row (e.g. a checked toggle). */ enabledMarker: string;
  /** Marketplaces already added ("owner/repo" text). */ marketplaceRow: string;
  addPluginButton: string; addMarketplaceButton: string; marketplaceDialog: string; marketplaceField: string; marketplaceSubmit: string;
  /** A plugin row in the added marketplace's Discover list, and the control that adds it. */ discoverRow: string; discoverAddButton: string;
  /** The on/off control on a "Yours" row. */ enableToggle: string;
  signedOutMarkers: string[]; humanCheck: { titles: string[]; bodyMarkers: string[]; frameHosts: string[] };
  timing: PluginsTiming;
  /** Keys whose entry is not marked "verified" in the data file. */ unverified: string[];
}

const KEYS = ["hosts", "pluginsUrl", "pluginRow", "pluginName", "enabledMarker", "marketplaceRow", "addPluginButton", "addMarketplaceButton", "marketplaceDialog", "marketplaceField", "marketplaceSubmit", "discoverRow", "discoverAddButton", "enableToggle", "signedOutMarkers", "humanCheck", "timing"] as const;

export function loadPluginsSpec(file = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"), "claude-plugins.json")): PluginsSpec {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const out: Record<string, unknown> = { unverified: [] as string[] };
  for (const k of KEYS) {
    const e = raw[k];
    if (e === undefined) throw new Error(`${path.basename(file)}: "${k}" is missing`);
    const isEntry = !!e && typeof e === "object" && !Array.isArray(e) && "value" in (e as object);
    out[k] = isEntry ? (e as { value: unknown }).value : e;
    if (!isEntry || (e as { status?: string }).status !== "verified") (out.unverified as string[]).push(k);
  }
  const s = out as unknown as PluginsSpec;
  for (const [k, v] of Object.entries(s.timing)) if (/Ms$/.test(k) && k !== "pageMs" && k !== "elementMs" && (v as number) < 500) throw new Error(`${path.basename(file)}: timing.${k} must be 500 ms or more (no busy waiting)`);
  return s;
}

/**
 * Controls cc never clicks on the Plugins page, whatever the data file says: anything that disables, removes, uninstalls,
 * deletes, renames or reorders a plugin, touches another marketplace's management, a connector, memory, preferences,
 * billing or sign-in. "Add", "Enable", "Install" and a plugin's own name are NOT denied (that is the whole job).
 */
// Note: "permission" is deliberately NOT denied — it is not a destructive action and the gate name "helm-permission-gate"
// contains it (denying it would block enabling the very gate we must enable). The bounded add/enable roles already prevent
// clicking any settings control; this list is defence-in-depth against a mis-pointed selector naming a destructive control.
export const PLUGIN_CLICK_DENY = /\b(delete|remove|uninstall|disable|turn off|rename|reorder|archive|share|invite|upgrade|billing|subscri|plan|payment|refund)\b|sign ?(in|out|up)|log ?(in|out)|continue with|connector|integration|\bmemory\b|preference|leave|disconnect|visibility|transfer/i;

const rx = (p: string) => new RegExp(p, "i");
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
const onHost = (u: string, hosts: string[]) => { const h = hostOf(u); return hosts.some((x) => h === x || h.endsWith("." + x)); };

export async function checkPage(page: Page, spec: PluginsSpec): Promise<void> {
  const title = (await page.title().catch(() => "")).toLowerCase();
  const body = (await page.evaluate(() => document.body?.innerText.slice(0, 800) ?? "").catch(() => "")).toLowerCase();
  const frames = page.frames().map((f) => hostOf(f.url()));
  const hc = spec.humanCheck;
  if (hc.titles.some((t) => title.includes(t)) || hc.bodyMarkers.some((m) => body.includes(m)) || frames.some((h) => hc.frameHosts.some((x) => h === x || h.endsWith("." + x)))) {
    throw new BlockedError("human-check", `a human-check page was shown at ${safeUrl(page.url())}; cc does not try to get past it`);
  }
  if (!onHost(page.url(), spec.hosts)) throw new BlockedError("unexpected-page", `landed on ${safeUrl(page.url())}, which is not ${spec.hosts.join(" or ")}; stopped`);
  const p = (() => { try { return new URL(page.url()).pathname; } catch { return ""; } })();
  if (/\/login|\/logout/.test(p) || spec.signedOutMarkers.some((m) => body.includes(m))) {
    throw new BlockedError("signed-out", "claude.ai is not signed in in this account's master profile; run `cc browser signin --account <id>` (cc does not sign in here)");
  }
}

async function controlName(l: Locator): Promise<string> {
  return l.evaluate((el) => (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)).catch(() => "");
}

export type PluginClickRole = "add-plugin-menu" | "add-marketplace" | "marketplace-submit" | "add-gate" | "enable-gate";

/** The ONLY way this file clicks: right host, an allowed add/enable role, and a control name that is not on the deny list. */
export async function guardedClick(page: Page, l: Locator, role: PluginClickRole, spec: PluginsSpec): Promise<void> {
  if (!onHost(page.url(), spec.hosts)) throw new Error(`refusing to click (${role}): the page is ${safeUrl(page.url())}, not ${spec.hosts.join(" or ")}`);
  if ((await l.count()) === 0) throw new Error(`no control for ${role} on ${safeUrl(page.url())}; fix data/selectors/claude-plugins.json`);
  const name = await controlName(l);
  if (PLUGIN_CLICK_DENY.test(name)) throw new Error(`refusing to click "${name}" (${role}): cc only adds/enables the declared gates, never a destructive control; fix data/selectors/claude-plugins.json`);
  await l.evaluate((el) => (el as HTMLElement).click());
}

const byName = (scope: Page | Locator, pattern: string) => scope.getByRole("button", { name: rx(pattern) }).or(scope.getByRole("link", { name: rx(pattern) })).first();

async function waitFor(cond: () => Promise<boolean>, ms: number, pollMs: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) { if (await cond()) return true; if (Date.now() > end) return false; await sleep(Math.max(500, pollMs)); }
}

export function claudePluginsDriver(page: Page, spec: PluginsSpec): PluginsPage {
  const t = spec.timing;
  const goto = async (url: string) => { await page.goto(url, { waitUntil: "domcontentloaded", timeout: t.pageMs }); await sleep(t.settleMs); await checkPage(page, spec); };
  const readYours = () => page.$$eval(spec.pluginRow, (rows, sel) => rows.map((r) => {
    const n = sel.name ? r.querySelector(sel.name) : null;
    const name = ((n as HTMLElement)?.innerText ?? (r as HTMLElement).innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
    const enabled = sel.enabled ? !!r.querySelector(sel.enabled) : false;
    return { name, enabled };
  }), { name: spec.pluginName, enabled: spec.enabledMarker });

  const openAddMenu = async () => { await guardedClick(page, byName(page.locator("body"), spec.addPluginButton), "add-plugin-menu", spec); await sleep(t.settleMs); };

  return {
    async listInstalled(): Promise<InstalledPlugin[]> {
      await goto(spec.pluginsUrl);
      await page.waitForSelector(spec.pluginRow, { timeout: t.elementMs }).catch(() => {}); // an account with no plugins has none
      let last = -1, stable = 0, rows: InstalledPlugin[] = [];
      for (let i = 0; i < 40 && stable < t.listStableChecks; i++) {
        rows = await readYours();
        stable = rows.length === last ? stable + 1 : 0;
        last = rows.length;
        await sleep(Math.max(500, t.pollMs));
      }
      if (stable < t.listStableChecks) throw new Error(`the plugin list did not finish loading (${rows.length} seen); refusing to decide on a partial list`);
      const seen = new Set<string>();
      return rows.filter((r) => r.name && !seen.has(r.name) && seen.add(r.name));
    },
    async listMarketplaces(): Promise<string[]> {
      await goto(spec.pluginsUrl);
      const rows = await page.$$eval(spec.marketplaceRow, (els) => els.map((e) => ((e as HTMLElement).innerText ?? "").trim()).filter(Boolean)).catch(() => [] as string[]);
      // keep only "owner/repo"-shaped tokens
      return rows.map((r) => (r.match(/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*/) ?? [""])[0]).filter(Boolean);
    },
    async addMarketplace(repo: string): Promise<void> {
      await goto(spec.pluginsUrl);
      await openAddMenu();
      await guardedClick(page, byName(page.locator("body"), spec.addMarketplaceButton), "add-marketplace", spec);
      const dlg = page.locator(spec.marketplaceDialog).last();
      const f = dlg.locator(spec.marketplaceField).first();
      if (!(await waitFor(async () => (await f.count()) > 0, t.elementMs, 500))) throw new Error(`no marketplace field (${spec.marketplaceField}) in an add-marketplace dialog on ${safeUrl(page.url())}; fix data/selectors/claude-plugins.json`);
      await f.fill(repo);
      await guardedClick(page, byName(dlg, spec.marketplaceSubmit), "marketplace-submit", spec);
      await sleep(t.settleMs);
      await checkPage(page, spec);
    },
    async addGate(name: string): Promise<void> {
      await goto(spec.pluginsUrl);
      const row = page.locator(spec.discoverRow).filter({ hasText: name }).first();
      if (!(await waitFor(async () => (await row.count()) > 0, t.elementMs, 500))) throw new Error(`plugin "${name}" was not found in the marketplace's list on ${safeUrl(page.url())} (is the marketplace added?); fix data/selectors/claude-plugins.json (discoverRow)`);
      await guardedClick(page, row.locator(spec.discoverAddButton).first(), "add-gate", spec);
      await sleep(t.settleMs);
      await checkPage(page, spec);
    },
    async enableGate(name: string): Promise<void> {
      await goto(spec.pluginsUrl);
      const row = page.locator(spec.pluginRow).filter({ hasText: name }).first();
      if (!(await waitFor(async () => (await row.count()) > 0, t.elementMs, 500))) throw new Error(`plugin "${name}" is not in "Yours" on ${safeUrl(page.url())}; fix data/selectors/claude-plugins.json (pluginRow)`);
      // idempotent: only click the toggle when it is currently OFF, so an already-on gate is never turned off
      const alreadyOn = (await row.locator(spec.enabledMarker).count()) > 0;
      if (alreadyOn) return;
      await guardedClick(page, row.locator(spec.enableToggle).first(), "enable-gate", spec);
      await sleep(t.settleMs);
      await checkPage(page, spec);
    },
  };
}
