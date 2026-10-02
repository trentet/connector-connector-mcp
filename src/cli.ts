import path from "node:path";
import { loadRegistry } from "./core/registry.js";
import { ADAPTERS } from "./adapters/index.js";
import { audit } from "./audit.js";
import { run } from "./core/runner.js";
import { PLATFORMS, type Op, type Platform } from "./core/types.js";

const OPS: Op[] = ["add", "remove", "update", "list", "verify", "probe"];
const USAGE = `cc audit --scan <repo-root> [--json]     (find per-repo registration scripts that cc replaces)
cc <op> [connector-id ...|--all] [--platform <claude|chatgpt|grok ...>|all] [--dry-run] [--include-test] [--registry <path>] [--if-existing skip|update|fail] [--json]
ops: ${OPS.join(", ")}`;


export interface ParsedFlags { ids: string[]; platforms: Platform[]; dryRun: boolean; includeTest: boolean; json: boolean; ifExisting?: "skip" | "update" | "fail"; registryPath: string }

/** --platform takes one or more platform names (or "all"); it stops at the first word that is not a platform, which is then a connector id. */
export function parseFlags(args: string[]): ParsedFlags | { error: string } {
  const ids: string[] = [];
  let platforms: Platform[] = PLATFORMS, dryRun = false, includeTest = false, json = false, ifExisting: ParsedFlags["ifExisting"];
  let registryPath = path.resolve("registry", "connectors.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") ids.push("*");
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--include-test") includeTest = true;
    else if (a === "--json") json = true;
    else if (a === "--registry") registryPath = path.resolve(args[++i]);
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
  return { ids, platforms, dryRun, includeTest, json, ifExisting, registryPath };
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice();
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
