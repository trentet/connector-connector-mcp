// Diagnostic: how does an MCP server answer the kinds of requests platform "add connector" probes send? Token read in-process, never printed.
import { loadRegistry } from "../../dist/core/registry.js";
import { Redactor } from "../../dist/core/redact.js";
import { resolve } from "../../dist/core/secrets.js";
const [registryPath, id, platform = "grok"] = process.argv.slice(2);
const reg = loadRegistry(registryPath);
const c = reg.connectors.find((x) => x.id === id);
const red = new Redactor();
const full = await resolve(c.urlByPlatform?.[platform] ?? c.url, red);
const u = new URL(full);
const base = u.origin;
const hdrVal = c.auth.headerValue ? await resolve(c.auth.headerValue, red) : null;
const R = (x) => red.redact(String(x));
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cc-probe", version: "0" } } };
const t = async (label, url, opts = {}) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
    const body = (await r.text()).slice(0, 140).replace(/\s+/g, " ");
    return { label, status: r.status, type: r.headers.get("content-type"), wwwAuth: r.headers.get("www-authenticate"), body: R(body) };
  } catch (e) { return { label, error: R(e.message) }; }
};
const post = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) };
const results = [];
results.push(await t("POST initialize, URL as registered", full, post));
results.push(await t("POST initialize, no token anywhere", base + u.pathname, post));
if (hdrVal) results.push(await t("POST initialize, header only", base + u.pathname, { ...post, headers: { ...post.headers, [c.auth.headerName]: hdrVal } }));
results.push(await t("GET URL as registered (SSE-style)", full, { headers: { accept: "text/event-stream" } }));
results.push(await t("GET /.well-known/oauth-authorization-server", base + "/.well-known/oauth-authorization-server"));
results.push(await t("GET /.well-known/oauth-protected-resource", base + "/.well-known/oauth-protected-resource"));
results.push(await t("POST /register (dynamic client reg)", base + "/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
console.log(JSON.stringify({ origin: base, path: u.pathname, queryKeys: [...u.searchParams.keys()], results }, null, 1));
