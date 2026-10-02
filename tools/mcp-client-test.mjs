// End-to-end check of the MCP front door over a real URL. Token is read from the env's secrets file in-process and never printed.
//   node tools/mcp-client-test.mjs <base-url> <path-to-connector.env> [--live]
import { readFileSync } from "node:fs";
const [base, secretsPath, flag] = process.argv.slice(2);
const token = (readFileSync(secretsPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("CC_MCP_BEARER_TOKEN=")) ?? "").split("=", 2)[1]?.trim();
if (!token) { console.error("no CC_MCP_BEARER_TOKEN in secrets file"); process.exit(2); }
const post = (body, headers = {}) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
const parse = async (r) => { const t = await r.text(); const m = /data: (.*)/.exec(t); try { return JSON.parse(m ? m[1] : t); } catch { return { raw: t.slice(0, 200) }; } };
const redact = (s) => String(s).split(token).join("<TOKEN>");
const out = [];
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cc-e2e", version: "0" } } };
out.push({ check: "no token -> 401", status: (await post(init)).status });
out.push({ check: "wrong token -> 401", status: (await post(init, { "x-api-key": "x".repeat(40) })).status });
const H = { "x-api-key": token };
out.push({ check: "initialize with token", status: (await post(init, H)).status });
const tools = await parse(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, H));
out.push({ check: "tools/list", tools: tools.result?.tools?.map((t) => t.name) });
const reg = await parse(await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cc_list_registry", arguments: {} } }, H));
out.push({ check: "cc_list_registry", ids: JSON.parse(reg.result.content[0].text).map((c) => c.id) });
const smuggle = await parse(await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cc_run", arguments: { op: "verify", connectors: ["helm-drive"], url: "https://evil.example/?token=abc" } } }, H));
out.push({ check: "smuggled url argument rejected", error: smuggle.error?.message?.slice(0, 80) });
const dry = await parse(await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "cc_run", arguments: { op: "add", connectors: ["*"], platforms: ["claude", "chatgpt", "grok"], dry_run: true } } }, H));
const dryRes = JSON.parse(dry.result.content[0].text);
out.push({ check: "dry-run add --all, all platforms", ok: dryRes.ok, counts: dryRes.items.reduce((a, i) => ((a[i.status] = (a[i.status] ?? 0) + 1), a), {}) });
if (flag === "--live") {
  for (const platform of ["claude", "chatgpt", "grok"]) {
    const t0 = Date.now();
    const live = await parse(await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "cc_run", arguments: { op: "verify", connectors: ["helm-drive", "helm-shell"], platforms: [platform] } } }, H));
    const res = JSON.parse(live.result.content[0].text);
    out.push({ check: `LIVE verify helm-drive, helm-shell @ ${platform}`, secs: Math.round((Date.now() - t0) / 1000), items: res.items.map((i) => `${i.connector}: ${i.status} - ${i.detail}`) });
  }
}
const text = redact(JSON.stringify(out, null, 1));
console.log(text);
console.log(text.includes(token) ? "LEAK: token present in output" : "no token in output");
