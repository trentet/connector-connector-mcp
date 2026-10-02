#!/usr/bin/env node
/**
 * Start the deployed cc server for one environment. Secrets come from <base>/<env>/secrets/connector.env
 * (CC_MCP_BEARER_TOKEN, and optionally CC_CHROME_PROFILE / CC_CHROME_PATH / BW_SERVE_URL) -- never from the repo.
 *   node scripts/start.mjs <production|test>
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENVS, HOSTNAMES, PORTS, deployDir, secretsFile } from "./env.mjs";

const env = process.argv[2];
if (!ENVS.includes(env)) { console.error(`Usage: node scripts/start.mjs <${ENVS.join("|")}>`); process.exit(2); }
const dir = deployDir(env);
if (!existsSync(join(dir, "dist", "server", "http.js"))) { console.error(`Not deployed: ${join(dir, "dist", "server", "http.js")} missing. Run: node scripts/deploy.mjs ${env}`); process.exit(2); }
const childEnv = { ...process.env };
const sf = secretsFile(env);
if (!existsSync(sf)) { console.error(`No secrets file at ${sf} (expects CC_MCP_BEARER_TOKEN=..., at least 32 characters).`); process.exit(2); }
for (const line of readFileSync(sf, "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  let v = t.slice(eq + 1).trim(); if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
  childEnv[t.slice(0, eq).trim()] = v;
}
// Environment-owned values the secrets file cannot override.
childEnv.PORT = String(PORTS[env]);
childEnv.HOST = "127.0.0.1";
childEnv.CC_ALLOWED_HOSTS = `${HOSTNAMES[env]},localhost,127.0.0.1`;
childEnv.CC_REGISTRY = childEnv.CC_REGISTRY ?? join(dir, "registry", "connectors.json");
const child = spawn(process.execPath, [join(dir, "dist", "server", "http.js")], { cwd: dir, env: childEnv, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
