#!/usr/bin/env node
/**
 * Deploy a pinned, built copy of cc for one environment.
 *   node scripts/deploy.mjs <production|test> [git-ref]
 * Lives under <base>/deploy/<env> (outside any cloud-sync folder). Idempotent. Refuses to redeploy a RUNNING
 * instance (on Windows a running server holds native modules open and `npm ci` fails halfway).
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENVS, PORTS, deployDir } from "./env.mjs";

const [env, ref = "main"] = process.argv.slice(2);
if (!ENVS.includes(env)) { console.error(`Usage: node scripts/deploy.mjs <${ENVS.join("|")}> [git-ref]`); process.exit(2); }

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const sh = (cmd, args, opts) => process.platform === "win32" ? spawnSync([cmd, ...args].map(quote).join(" "), { ...opts, shell: true }) : spawnSync(cmd, args, { ...opts, shell: false });
function run(cmd, args, cwd, { capture = false } = {}) {
  const r = sh(cmd, args, { cwd, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (r.status !== 0) { console.error(`FAILED: ${cmd} ${args.join(" ")} (exit ${r.status})`); process.exit(1); }
  return capture ? r.stdout.trim() : "";
}

const port = Number(process.env.CC_PORT ?? PORTS[env]);
const inUse = await new Promise((done) => { const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); done(true); }); s.on("error", () => done(false)); s.setTimeout(1500, () => { s.destroy(); done(false); }); });
if (inUse) { console.error(`Refusing to deploy ${env}: something is listening on port ${port}. Stop the ${env} instance first.`); process.exit(3); }

const sourceRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = deployDir(env);
const repoUrl = run("git", ["remote", "get-url", "origin"], sourceRepo, { capture: true });
console.log(`Deploying ${env} @ ${ref}\n  from ${repoUrl}\n  into ${dir}`);
if (!existsSync(join(dir, ".git"))) { mkdirSync(dirname(dir), { recursive: true }); run("git", ["clone", repoUrl, dir], process.cwd()); }
run("git", ["fetch", "origin", "--tags", "--prune"], dir);
const isBranch = sh("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${ref}`], { cwd: dir }).status === 0;
run("git", ["checkout", "--force", isBranch ? `origin/${ref}` : ref], dir);
run("npm", ["ci", "--no-audit", "--no-fund"], dir);
run("npm", ["run", "build"], dir);
const commit = run("git", ["rev-parse", "--short", "HEAD"], dir, { capture: true });
writeFileSync(join(dir, "DEPLOYED.json"), JSON.stringify({ env, ref, commit, deployed_at: new Date().toISOString(), deploy_dir: dir, port }, null, 2));
console.log(`Deployed ${env} at ${commit}. Start it with: node scripts/start.mjs ${env}`);
