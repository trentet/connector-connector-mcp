import type { BrowserSession } from "../browser/chrome.js";
import { notImplementedAdapter, type PlatformAdapter, type ResolvedConnector } from "../adapters/types.js";
import { Redactor } from "./redact.js";
import { resolve, defaultDeps, type ResolveDeps } from "./secrets.js";
import type { ConnectorDef, ItemResult, Platform, Registry, RunRequest, RunResult } from "./types.js";

export interface RunnerOptions {
  adapters?: Partial<Record<Platform, PlatformAdapter>>;
  deps?: ResolveDeps;
  /** Opens the browser session adapters share; defaults to attaching to the debug Chrome. */
  sessionFactory?: () => Promise<BrowserSession>;
}

/** The single code path used by BOTH the CLI and the MCP server. Knows ops and platforms, never a specific connector. */
export async function run(reg: Registry, req: RunRequest, opts: RunnerOptions = {}): Promise<RunResult> {
  const red = new Redactor();
  const deps = opts.deps ?? defaultDeps;
  const adapter = (p: Platform) => opts.adapters?.[p] ?? notImplementedAdapter(p);
  const items: ItemResult[] = [];
  let sess: BrowserSession | undefined;
  let opening: Promise<BrowserSession> | undefined;
  // One browser per run, opened lazily. A failed open is remembered, so every remaining item fails fast with the same error instead of each waiting for a lane again.
  const getSession = async () => { opening ??= (opts.sessionFactory ?? (async () => (await import("../browser/chrome.js")).openSession()))(); sess = await opening; return sess; };
  /** The session handed to a platform's adapter; records that this run drove that platform (decides whether its refreshed sign-in is written back). */
  const sessionFor = (platform: Platform) => async () => { const s = await getSession(); s.touched?.add(platform); return s; };
  try {
    await runItems();
  } finally {
    await sess?.close();
  }
  return { ok: items.every((i) => i.status !== "error"), items };

  async function runItems(): Promise<void> {
  const wanted = req.connectors.includes("*") ? reg.connectors.filter((c) => req.includeTest || c.tier !== "test") : req.connectors.map((id) => reg.connectors.find((c) => c.id === id) ?? id);
  const needsConnector = req.op !== "list" && req.op !== "probe";

  if (!needsConnector) {
    for (const platform of req.platforms) {
      const base = { connector: "*", platform, op: req.op } as const;
      try {
        if (req.dryRun) { items.push({ ...base, status: "dry-run", detail: "would " + req.op }); continue; }
        const ctx = { platform, redact: (x: string) => red.redact(x), session: sessionFor(platform) };
        const a = adapter(platform);
        const out = req.op === "list" ? { status: "ok" as const, detail: (await a.list(ctx)).names.join(", ") } : await a.probe(ctx);
        items.push({ ...base, status: out.status, detail: out.detail ? red.redact(out.detail) : undefined });
      } catch (e) { items.push({ ...base, status: "error", detail: red.redact((e as Error).message) }); }
    }
    return;
  }

  for (const c of wanted) {
    if (typeof c === "string") { for (const p of req.platforms) items.push({ connector: c, platform: p, op: req.op, status: "error", detail: "unknown connector id" }); continue; }
    for (const platform of req.platforms) {
      const base = { connector: c.id, platform, op: req.op } as const;
      if (!c.platforms.includes(platform)) { items.push({ ...base, status: "skipped", detail: "platform not enabled for this connector" }); continue; }
      try {
        const rc = needsConnector ? await resolveConnector(c, platform, red, deps) : undefined;
        if (req.dryRun) { items.push({ ...base, status: "dry-run", detail: describe(c, rc, red) }); continue; }
        const ctx = { platform, redact: (s: string) => red.redact(s), session: sessionFor(platform) };
        const a = adapter(platform);
        const ifx = req.ifExisting ?? reg.defaults?.ifExisting ?? "skip";
        const out =
          req.op === "list" ? { status: "ok" as const, detail: (await a.list(ctx)).names.join(", ") }
          : req.op === "probe" ? await a.probe(ctx)
          : req.op === "add" ? await a.add(ctx, rc!, ifx)
          : req.op === "remove" ? await a.remove(ctx, rc!)
          : req.op === "update" ? await a.update(ctx, rc!)
          : await a.verify(ctx, rc!);
        items.push({ ...base, status: out.status, detail: out.detail ? red.redact(out.detail) : undefined });
      } catch (e) {
        items.push({ ...base, status: "error", detail: red.redact((e as Error).message) });
      }
    }
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
