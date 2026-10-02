import path from "node:path";
import { loadRegistry } from "./core/registry.js";
import { ADAPTERS } from "./adapters/index.js";
import { audit } from "./audit.js";
import { run } from "./core/runner.js";
import { PLATFORMS, type Op, type Platform } from "./core/types.js";

const OPS: Op[] = ["add", "remove", "update", "list", "verify", "probe"];
const USAGE = `cc audit --scan <repo-root> [--json]     (find per-repo registration scripts that cc replaces)
cc <op> [connector-id ...|--all] [--platform claude|chatgpt|grok|all] [--dry-run] [--registry <path>] [--if-existing skip|update|fail] [--json]
ops: ${OPS.join(", ")}`;

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
  const ids: string[] = [];
  let platforms: Platform[] = PLATFORMS, dryRun = false, json = false, ifExisting: "skip" | "update" | "fail" | undefined;
  let registryPath = path.resolve("registry", "connectors.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") ids.push("*");
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else if (a === "--registry") registryPath = path.resolve(args[++i]);
    else if (a === "--if-existing") ifExisting = args[++i] as never;
    else if (a === "--platform") { const v = args[++i]; platforms = v === "all" ? PLATFORMS : [v as Platform]; if (platforms.some((p) => !PLATFORMS.includes(p))) { console.error(`unknown platform: ${v}`); return 2; } }
    else ids.push(a);
  }
  const reg = loadRegistry(registryPath);
  const res = await run(reg, { op, connectors: ids.length ? ids : op === "list" || op === "probe" ? ["*"] : [], platforms, dryRun, ifExisting }, { adapters: ADAPTERS });
  if (json) console.log(JSON.stringify(res, null, 2));
  else for (const i of res.items) console.log(`${i.status.padEnd(15)} ${i.op} ${i.connector} @ ${i.platform}${i.detail ? " - " + i.detail : ""}`);
  return res.ok ? 0 : 1;
}
