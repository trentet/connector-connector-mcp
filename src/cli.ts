import path from "node:path";
import { loadRegistry } from "./core/registry.js";
import { ADAPTERS } from "./adapters/index.js";
import { audit } from "./audit.js";
import { coverage, formatReport as formatGoogleReport, scanGithub, scanLocal, type Finding } from "./googleCoverage.js";
import { run } from "./core/runner.js";
import { reauth } from "./core/reauth.js";
import { checkMaster, seedMaster } from "./browser/seed.js";
import { formatReport, runThreads } from "./threads.js";
import { PLATFORMS, type Op, type Platform } from "./core/types.js";

const OPS: Op[] = ["add", "remove", "update", "list", "verify", "probe"];
const USAGE = `cc browser seed [--from-port <port>]   (one-time: copy platform sign-ins from a signed-in Chrome into cc's cold master profile)
cc browser check                          (clone the master into a throwaway browser and report which platforms are signed in)
cc audit --google [--root <dir> ...] [--github <owner>] [--registry <path>] [--json]   (find repos that use Google OAuth but have no registry googleOAuth block)
cc audit --scan <repo-root> [--json]     (find per-repo registration / Google-reauth scripts that cc replaces)
cc reauth [connector-id ...|--all] [--include-test] [--dry-run] [--only-if-older-than <days>] [--registry <path>] [--json]   (renew the Google OAuth token of connectors with a googleOAuth registry block; --only-if-older-than skips one renewed more recently, for a second renewer)
cc threads [--json]                       (read-only: list the claude.ai/code threads as id, status, title, and say plainly what could and could not be read; one browser, never writes to claude.ai)
cc <op> [connector-id ...|--all] [--platform <claude|chatgpt|grok ...>|all] [--dry-run] [--include-test] [--registry <path>] [--if-existing skip|update|fail] [--json]
ops: ${OPS.join(", ")}`;


export interface ParsedFlags { ids: string[]; platforms: Platform[]; dryRun: boolean; includeTest: boolean; json: boolean; ifExisting?: "skip" | "update" | "fail"; registryPath: string; onlyIfOlderThanDays?: number }

/** --platform takes one or more platform names (or "all"); it stops at the first word that is not a platform, which is then a connector id. */
export function parseFlags(args: string[]): ParsedFlags | { error: string } {
  const ids: string[] = [];
  let platforms: Platform[] = PLATFORMS, dryRun = false, includeTest = false, json = false, ifExisting: ParsedFlags["ifExisting"], onlyIfOlderThanDays: number | undefined;
  let registryPath = path.resolve("registry", "connectors.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") ids.push("*");
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--include-test") includeTest = true;
    else if (a === "--json") json = true;
    else if (a === "--registry") registryPath = path.resolve(args[++i]);
    else if (a === "--only-if-older-than") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "--only-if-older-than needs a positive number of days, for example 4.75" };
      onlyIfOlderThanDays = v;
    }
    else if (a === "--if-existing") ifExisting = args[++i] as never;
    else if (a === "--platform") {
      const first = args[++i];
      if (first === undefined || first.startsWith("--")) return { error: "--platform needs a value: claude, chatgpt, grok, or all" };
      if (first !== "all" && !PLATFORMS.includes(first as Platform)) return { error: `unknown platform: ${first}` };
      const picked = new Set<Platform>(first === "all" ? PLATFORMS : [first as Platform]);
      while (i + 1 < args.length && (PLATFORMS.includes(args[i + 1] as Platform) || args[i + 1] === "all")) {
        const n = args[++i];
        for (const p of n === "all" ? PLATFORMS : [n as Platform]) picked.add(p);
      }
      platforms = PLATFORMS.filter((p) => picked.has(p));
    }
    else ids.push(a);
  }
  return { ids, platforms, dryRun, includeTest, json, ifExisting, registryPath, onlyIfOlderThanDays };
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice();
  if (args[0] === "audit" && args.includes("--google")) {
    const roots: string[] = []; let owner: string | undefined; let regPath = path.resolve("registry", "connectors.json");
    for (let i = 1; i < args.length; i++) { if (args[i] === "--root") roots.push(args[++i]); else if (args[i] === "--github") owner = args[++i]; else if (args[i] === "--registry") regPath = path.resolve(args[++i]); }
    if (roots.length === 0 && !owner) { console.error("usage: cc audit --google [--root <dir> ...] [--github <owner>] [--registry <path>] [--json]"); return 2; }
    const findings: Finding[] = scanLocal(roots), errors: string[] = [];
    if (owner) { const g = scanGithub(owner); findings.push(...g.findings); errors.push(...g.errors); }
    const rep = coverage(findings, loadRegistry(regPath));
    if (args.includes("--json")) console.log(JSON.stringify({ ...rep, scanned: findings.length, errors }, null, 2));
    else { console.log(`scanned ${findings.length} repo(s)`); for (const l of formatGoogleReport(rep)) console.log(l); for (const e of errors) console.log(`note       ${e}`); if (!rep.uncovered.length && !rep.problems.length) console.log("google coverage: every repo that uses Google OAuth is covered, exempt or pending"); }
    return rep.uncovered.length || rep.problems.length ? 1 : 0;
  }
  if (args[0] === "audit") {
    const i = args.indexOf("--scan");
    const root = i >= 0 ? args[i + 1] : undefined;
    if (!root) { console.error("usage: cc audit --scan <repo-root> [--json]"); return 2; }
    const hits = audit(root);
    if (args.includes("--json")) console.log(JSON.stringify(hits, null, 2));
    else if (hits.length === 0) console.log(`audit: no registration-script look-alikes under ${root}`);
    else for (const h of hits) console.log(`${h.file}\n    ${h.reasons.join("; ")}`);
    return hits.length ? 1 : 0;
  }
  if (args[0] === "reauth") {
    const parsed = parseFlags(args.slice(1));
    if ("error" in parsed) { console.error(parsed.error); return 2; }
    if (parsed.ids.length === 0) { console.error("usage: cc reauth <connector-id ...|--all> [--include-test] [--dry-run] [--only-if-older-than <days>] [--registry <path>] [--json]"); return 2; }
    const res = await reauth(loadRegistry(parsed.registryPath), { connectors: parsed.ids, includeTest: parsed.includeTest, dryRun: parsed.dryRun, onlyIfOlderThanDays: parsed.onlyIfOlderThanDays });
    if (parsed.json) console.log(JSON.stringify(res, null, 2));
    else for (const i of res.items) console.log(`${i.status.padEnd(8)} reauth ${i.connector}${i.detail ? " - " + i.detail : ""}`);
    return res.ok ? 0 : 1;
  }
  if (args[0] === "threads") {
    const { openSession } = await import("./browser/chrome.js");
    const rep = await runThreads({ open: () => openSession() });
    if (args.includes("--json")) console.log(JSON.stringify(rep, null, 2));
    else for (const l of formatReport(rep)) console.log(l);
    return rep.ok ? 0 : 1;
  }
  if (args[0] === "browser") {
    const sub = args[1];
    try {
      if (sub === "seed") {
        const i = args.indexOf("--from-port");
        const r = await seedMaster(Number(i >= 0 ? args[i + 1] : 9222));
        for (const p of Object.keys(r.copied)) console.log(`${p.padEnd(8)} ${String(r.copied[p]).padStart(3)} cookies copied, signed in: ${r.signedIn[p] ? "yes" : "NO"}`);
        return Object.values(r.signedIn).every(Boolean) ? 0 : 1;
      }
      if (sub === "check") {
        const r = await checkMaster();
        for (const [p, ok] of Object.entries(r)) console.log(`${p.padEnd(8)} signed in: ${ok ? "yes" : "NO"}`);
        return Object.values(r).every(Boolean) ? 0 : 1;
      }
    } catch (e) { console.error(`browser ${sub}: ${(e as Error).message}`); return 1; }
    console.error("usage: cc browser seed [--from-port <port>] | cc browser check"); return 2;
  }
  const op = args.shift() as Op | undefined;
  if (!op || op === ("--help" as never) || !OPS.includes(op)) { console.log(USAGE); return op ? 2 : 0; }
  const parsed = parseFlags(args);
  if ("error" in parsed) { console.error(parsed.error); return 2; }
  const { ids, platforms, dryRun, includeTest, json, ifExisting, registryPath } = parsed;
  const reg = loadRegistry(registryPath);
  const res = await run(reg, { op, connectors: ids.length ? ids : op === "list" || op === "probe" ? ["*"] : [], platforms, dryRun, includeTest, ifExisting }, { adapters: ADAPTERS });
  if (json) console.log(JSON.stringify(res, null, 2));
  else for (const i of res.items) console.log(`${i.status.padEnd(15)} ${i.op} ${i.connector} @ ${i.platform}${i.detail ? " - " + i.detail : ""}`);
  return res.ok ? 0 : 1;
}
