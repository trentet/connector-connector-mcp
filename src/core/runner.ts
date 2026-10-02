import type { BrowserSession } from "../browser/chrome.js";
import { notImplementedAdapter, type PlatformAdapter, type ResolvedConnector } from "../adapters/types.js";
import { Redactor } from "./redact.js";
import { resolve, defaultDeps, type ResolveDeps } from "./secrets.js";
import type { ConnectorDef, ItemResult, Platform, Registry, RunRequest, RunResult } from "./types.js";

export interface RunnerOptions {
  adapters?: Partial<Record<Platform, PlatformAdapter>>;
  deps?: ResolveDeps;
  /** Opens the browser session a platform's adapter uses; defaults to a fresh per-run Chrome. Called at most once per platform per run. */
  sessionFactory?: (platform: Platform) => Promise<BrowserSession>;
  /** How many platforms run at the same time (default CC_PLATFORM_PARALLELISM, else 1: measured slower on the HELM host when higher, see docs/SPEC.md section 9). */
  platformParallelism?: number;
}

interface Task { idx: number; platform: Platform; connector?: ConnectorDef }

/**
 * The single code path used by BOTH the CLI and the MCP server. Knows ops and platforms, never a specific connector.
 *
 * Platforms are independent (separate accounts, logins and pages), so each platform gets its own worker with its own browser;
 * `platformParallelism` (CC_PLATFORM_PARALLELISM) says how many workers run at the same time. The default is 1 because on the
 * HELM host (8 cores) each cc Chrome burns ~1.7 cores and three at once measured SLOWER than one after another. Items within one
 * platform always stay sequential (two connectors added at once in one account could race on that platform's list).
 * Results come back in the original connector-major, platform-minor order.
 */
export async function run(reg: Registry, req: RunRequest, opts: RunnerOptions = {}): Promise<RunResult> {
  const red = new Redactor();
  const deps = opts.deps ?? defaultDeps;
  const adapter = (p: Platform) => opts.adapters?.[p] ?? notImplementedAdapter(p);
  const results: ItemResult[] = [];
  const sessions = new Map<Platform, Promise<BrowserSession>>();
  // One browser per platform, opened lazily. A failed open is remembered, so every remaining item on that platform fails fast with the same error instead of each waiting for a lane again.
  const trace = (m: string) => { if (process.env.CC_TRACE) console.error(`[trace +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`); }; // ids and seconds only, never values
  const t0 = Date.now();
  const sessionFor = (platform: Platform) => async () => {
    let p = sessions.get(platform);
    if (!p) {
      const t = Date.now();
      p = (opts.sessionFactory ?? (async () => (await import("../browser/chrome.js")).openSession()))(platform);
      sessions.set(platform, p);
      void p.then(() => trace(`${platform}: browser ready in ${((Date.now() - t) / 1000).toFixed(1)}s`), () => trace(`${platform}: browser failed to open`));
    }
    const s = await p;
    s.touched?.add(platform); // records that this browser drove this platform (decides whether its refreshed sign-in is merged back)
    return s;
  };
  try {
    await runTasks();
  } finally {
    await Promise.allSettled([...sessions.values()].map(async (p) => { try { await (await p).close(); } catch { /* a session that never opened has nothing to close */ } }));
  }
  const items = results.filter(Boolean);
  return { ok: items.every((i) => i.status !== "error"), items };

  async function runTasks(): Promise<void> {
    const wanted = req.connectors.includes("*") ? reg.connectors.filter((c) => req.includeTest || c.tier !== "test") : req.connectors.map((id) => reg.connectors.find((c) => c.id === id) ?? id);
    const needsConnector = req.op !== "list" && req.op !== "probe";
    const tasks: Task[] = [];
    let idx = 0;
    if (!needsConnector) {
      for (const platform of req.platforms) tasks.push({ idx: idx++, platform });
    } else {
      for (const c of wanted) {
        if (typeof c === "string") { for (const p of req.platforms) results[idx++] = { connector: c, platform: p, op: req.op, status: "error", detail: "unknown connector id" }; continue; }
        for (const platform of req.platforms) {
          if (!c.platforms.includes(platform)) { results[idx++] = { connector: c.id, platform, op: req.op, status: "skipped", detail: "platform not enabled for this connector" }; continue; }
          tasks.push({ idx: idx++, platform, connector: c });
        }
      }
    }
    const byPlatform = new Map<Platform, Task[]>();
    for (const t of tasks) byPlatform.set(t.platform, [...(byPlatform.get(t.platform) ?? []), t]);
    const limit = Math.max(1, opts.platformParallelism ?? (Number(process.env.CC_PLATFORM_PARALLELISM) || 1));
    const queue = [...byPlatform.values()];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let w = queue.shift(); w; w = queue.shift()) for (const t of w) results[t.idx] = await runTask(t, needsConnector);
    }));
  }

  async function runTask(t: Task, needsConnector: boolean): Promise<ItemResult> {
    const { platform, connector: c } = t;
    const base = { connector: c?.id ?? "*", platform, op: req.op } as const;
    const started = Date.now();
    trace(`${platform}: ${req.op} ${base.connector} start`);
    try {
      return await doTask(t, needsConnector, base);
    } finally { trace(`${platform}: ${req.op} ${base.connector} done in ${((Date.now() - started) / 1000).toFixed(1)}s`); }
  }

  async function doTask(t: Task, needsConnector: boolean, base: { connector: string; platform: Platform; op: RunRequest["op"] }): Promise<ItemResult> {
    const { platform, connector: c } = t;
    try {
      const rc = c && needsConnector ? await resolveConnector(c, platform, red, deps) : undefined;
      if (req.dryRun) return { ...base, status: "dry-run", detail: c ? describe(c, rc, red) : "would " + req.op };
      const ctx = { platform, redact: (x: string) => red.redact(x), session: sessionFor(platform) };
      const a = adapter(platform);
      const ifx = req.ifExisting ?? reg.defaults?.ifExisting ?? "skip";
      const out =
        req.op === "list" ? { status: "ok" as const, detail: (await a.list(ctx)).names.join(", ") }
        : req.op === "probe" ? await a.probe(ctx)
        : req.op === "add" ? await a.add(ctx, rc!, ifx)
        : req.op === "remove" ? await a.remove(ctx, rc!)
        : req.op === "update" ? await a.update(ctx, rc!)
        : await a.verify(ctx, rc!);
      return { ...base, status: out.status, detail: out.detail ? red.redact(out.detail) : undefined };
    } catch (e) {
      return { ...base, status: "error", detail: red.redact((e as Error).message) };
    }
  }
}

async function resolveConnector(c: ConnectorDef, platform: Platform, red: Redactor, deps: ResolveDeps): Promise<ResolvedConnector> {
  const url = await resolve(c.urlByPlatform?.[platform] ?? c.url, red, deps);
  red.add(url.includes("?") ? url.slice(url.indexOf("?") + 1) : undefined);
  const headerValue = c.auth.mode === "header" && c.auth.headerValue ? await resolve(c.auth.headerValue, red, deps) : undefined;
  return { def: c, name: c.nameByPlatform?.[platform] ?? c.name, url, headerValue };
}

function describe(c: ConnectorDef, rc: ResolvedConnector | undefined, red: Redactor): string {
  if (!rc) return `${c.name}: ok`;
  let target = "<unparseable url>";
  try { const u = new URL(rc.url); target = `${u.origin}${u.pathname}${u.search ? "?<query redacted>" : ""}`; } catch { /* keep placeholder */ }
  const hdr = rc.headerValue ? `, header ${c.auth.headerName} set (${rc.headerValue.length} chars)` : "";
  return red.redact(`${c.name}: url=${target}${hdr}`);
}
