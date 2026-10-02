#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildApp } from "./app.js";

function loadDotEnv(file = ".env"): void {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

loadDotEnv();
const token = process.env.CC_MCP_BEARER_TOKEN;
if (!token || token.length < 32) {
  console.error("CC_MCP_BEARER_TOKEN is not set (or shorter than 32 chars); refusing to start. Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8810);
const allowedHosts = (process.env.CC_ALLOWED_HOSTS ?? "cc.trentt.me,localhost,127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
const registryPath = path.resolve(process.env.CC_REGISTRY ?? "registry/connectors.json");
buildApp({ token, registryPath, host, allowedHosts }).listen(port, host, () => {
  console.error(`connector-connector-mcp listening on http://${host}:${port}/mcp (health: /health), registry: ${registryPath}`);
});
