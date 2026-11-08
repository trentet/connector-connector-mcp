import fs from "node:fs";
import path from "node:path";
import type { AccountPlugins } from "./accounts.js";

/**
 * `cc plugins apply|verify` — deterministic, code-driven deployment of the HELM AMS gate plugins to a claude.ai account,
 * so EVERY new thread/session of the account is governed (AGM-DEPLOY-001 in trentet/helm-agent-management, RULE-264).
 *
 * Why it exists: a local `claude plugin install` never reaches the claude.ai account, so it never syncs to new sessions;
 * account-plugin registration (Customize -> Plugins) has no CLI/API, so the only mechanism is claude.ai UI automation.
 * This module is the pure, testable plan + orchestration; src/adapters/claudePlugins.ts is the bounded page driver.
 *
 * Bounds (cc engineering default, NOT an operator-set limit): `apply` only ADDS/ENABLES the declared gates from the declared
 * marketplace. It never removes, disables, rewrites or reorders any plugin, never touches another marketplace, connectors,
 * memory, preferences, billing or sign-in. A gate already enabled is left exactly as is (idempotent: nothing is clicked).
 * A result is real only when read back (CLAUDE.md rule 4): apply confirms every required gate enabled by re-reading "Yours".
 */

export type PluginsOp = "apply" | "verify";

/** One plugin as the account's "Yours" list shows it. */
export interface InstalledPlugin { name: string; enabled: boolean; marketplace?: string }

export interface PluginItem {
  gate: string;
  status: "ok" | "dry-run" | "error";
  action?: "added" | "enabled" | "already-enabled" | "missing" | "disabled" | "would-apply" | "would-verify";
  detail: string;
}
export interface PluginsResult { ok: boolean; account: string; op: PluginsOp; marketplace: string; items: PluginItem[]; notes: string[] }

/** What `apply` must do to reach "every required gate enabled", computed from the current "Yours" list. Pure. */
export interface PluginPlan {
  /** required gate names not present in "Yours" at all — must be added from the marketplace. */
  toAdd: string[];
  /** required gate names present but switched off — must be enabled. */
  toEnable: string[];
  /** required gate names already enabled — left untouched. */
  already: string[];
  /** true when anything must be added, so the marketplace must be present first. */
  marketplaceNeeded: boolean;
}

/** Deterministic plan: for each required gate, add it (absent), enable it (present-off), or leave it (already on). */
export function planPlugins(installed: InstalledPlugin[], required: string[]): PluginPlan {
  const byName = new Map(installed.map((p) => [p.name, p]));
  const toAdd: string[] = [], toEnable: string[] = [], already: string[] = [];
  for (const g of required) {
    const p = byName.get(g);
    if (!p) toAdd.push(g);
    else if (!p.enabled) toEnable.push(g);
    else already.push(g);
  }
  return { toAdd, toEnable, already, marketplaceNeeded: toAdd.length > 0 };
}

/** Which required gates are NOT enabled right now (used by verify and by the apply read-back). Pure. */
export function missingGates(installed: InstalledPlugin[], required: string[]): string[] {
  const enabled = new Set(installed.filter((p) => p.enabled).map((p) => p.name));
  return required.filter((g) => !enabled.has(g));
}

/** The page side, one per browser. Production: claudePluginsDriver(session.page, spec). Every method is bounded in the adapter. */
export interface PluginsPage {
  /** The "Yours" tab: every plugin on the account with its on/off state. Read-only. */
  listInstalled(): Promise<InstalledPlugin[]>;
  /** The marketplaces already added to the account ("owner/repo"). Read-only. */
  listMarketplaces(): Promise<string[]>;
  /** Add a marketplace by "owner/repo" (Add plugin -> Add marketplace -> type repo -> submit). */
  addMarketplace(repo: string): Promise<void>;
  /** Add the named plugin from the (already added) marketplace so it appears enabled in "Yours". */
  addGate(name: string): Promise<void>;
  /** Switch an already-present but disabled plugin on. */
  enableGate(name: string): Promise<void>;
}
export interface PluginsSession { page: PluginsPage; close(): Promise<void>; /** e.g. "human-check" when the error is a BlockedError */ blockedKind?: (e: unknown) => string | undefined }

export interface PluginsOptions {
  dryRun?: boolean;
  /** Opens ONE browser for the whole call. Not called on a dry run. */
  open?: () => Promise<PluginsSession>;
  env?: NodeJS.ProcessEnv;
  /** Every line goes through the Redactor before it reaches this. */
  log?: (line: string) => void;
  /** Appended to (best effort), redacted, with a timestamp. */
  logFile?: string | null;
  sleep?: (ms: number) => Promise<void>;
  readBack?: { attempts: number; delayMs: number };
}

const DEFAULT_READBACK = { attempts: 4, delayMs: 1500 };

/**
 * Keep the declared gates enabled (apply) or just report their state (verify). One browser for the whole call.
 * apply is idempotent (all gates already enabled -> nothing clicked) and never removes or disables anything.
 */
export async function runPlugins(op: PluginsOp, acc: { id: string; plugins?: AccountPlugins }, opts: PluginsOptions = {}): Promise<PluginsResult> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const notes: string[] = [];
  const res = (ok: boolean, items: PluginItem[]): PluginsResult => ({ ok, account: acc.id, op, marketplace: acc.plugins?.marketplace ?? "", items, notes });

  if (!acc.plugins) return res(false, [{ gate: "-", status: "error", detail: `account "${acc.id}" declares no plugins block (registry/accounts.json)` }]);
  const { marketplace, gates } = acc.plugins;

  if (opts.dryRun) {
    const action = op === "apply" ? "would-apply" : "would-verify";
    log(`plugins ${op} (dry run): account ${acc.id}, marketplace ${marketplace}, gates ${gates.join(", ")} — no browser opened`);
    return res(true, gates.map((g) => ({ gate: g, status: "dry-run", action, detail: `${op} would ensure "${g}" from ${marketplace}` })));
  }
  if (!opts.open) return res(false, [{ gate: "-", status: "error", detail: "no browser opener provided (open)" }]);

  const session = await opts.open();
  const items: PluginItem[] = [];
  try {
    const installed = await session.page.listInstalled();
    if (op === "verify") {
      for (const g of gates) {
        const p = installed.find((x) => x.name === g);
        if (!p) items.push({ gate: g, status: "error", action: "missing", detail: `"${g}" is not on the account` });
        else if (!p.enabled) items.push({ gate: g, status: "error", action: "disabled", detail: `"${g}" is present but switched off` });
        else items.push({ gate: g, status: "ok", action: "already-enabled", detail: `"${g}" is enabled` });
      }
      return res(items.every((i) => i.status === "ok"), items);
    }

    // apply
    const plan = planPlugins(installed, gates);
    if (plan.marketplaceNeeded) {
      const markets = await session.page.listMarketplaces();
      if (!markets.includes(marketplace)) { log(`adding marketplace ${marketplace}`); await session.page.addMarketplace(marketplace); }
      else notes.push(`marketplace ${marketplace} already added`);
    }
    for (const g of plan.toAdd) { log(`adding gate ${g}`); await session.page.addGate(g); items.push({ gate: g, status: "ok", action: "added", detail: `added "${g}" from ${marketplace}` }); }
    for (const g of plan.toEnable) { log(`enabling gate ${g}`); await session.page.enableGate(g); items.push({ gate: g, status: "ok", action: "enabled", detail: `enabled "${g}"` }); }
    for (const g of plan.already) items.push({ gate: g, status: "ok", action: "already-enabled", detail: `"${g}" already enabled (left as is)` });

    // read-back: a result is real only when seen (CLAUDE.md rule 4)
    const rb = opts.readBack ?? DEFAULT_READBACK;
    let missing = gates.slice();
    for (let a = 0; a < rb.attempts; a++) {
      const back = await session.page.listInstalled();
      missing = missingGates(back, gates);
      if (missing.length === 0) break;
      if (a < rb.attempts - 1) await sleep(rb.delayMs);
    }
    if (missing.length) {
      for (const g of missing) { const it = items.find((i) => i.gate === g); if (it) { it.status = "error"; it.detail += " — but not enabled on read-back"; } else items.push({ gate: g, status: "error", action: "missing", detail: `"${g}" not enabled on read-back` }); }
      return res(false, items);
    }
    return res(true, items);
  } catch (e) {
    const kind = session.blockedKind?.(e);
    notes.push(kind ? `stopped: ${kind}` : `error: ${(e as Error).message}`);
    return res(false, items.length ? items : [{ gate: "-", status: "error", detail: kind ?? (e as Error).message }]);
  } finally {
    await session.close();
    if (opts.logFile) { try { fs.appendFileSync(opts.logFile, `${new Date().toISOString()} plugins ${op} ${acc.id}: ok=${items.every((i) => i.status === "ok")} (${items.map((i) => `${i.gate}:${i.action ?? i.status}`).join(", ")})\n`); } catch { /* best effort */ } }
  }
}

/** logs/plugins/<account>.log under CC_LOG_DIR, else <helm data base>/logs (same base the master profiles use). Mirrors settingsLogFile. */
export function pluginsLogFile(account: string, e: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (e.CC_LOG_DIR) return path.join(e.CC_LOG_DIR, "plugins", `${account}.log`);
    const app = (JSON.parse(fs.readFileSync(path.resolve("data", "app.json"), "utf8")) as { dataDirName: string }).dataDirName;
    const home = e.USERPROFILE ?? e.HOME ?? ".";
    const base = e.HELM_DATA_ROOT ?? (process.platform === "win32" ? path.join(e.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "HELM", app) : path.join(e.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "helm", app));
    return path.join(base, "logs", "plugins", `${account}.log`);
  } catch { return null; }
}
