import { notImplementedAdapter } from "../adapters/types.js";
import { Redactor } from "./redact.js";
import { resolve, defaultDeps } from "./secrets.js";
/** The single code path used by BOTH the CLI and the MCP server. Knows ops and platforms, never a specific connector. */
export async function run(reg, req, opts = {}) {
    const red = new Redactor();
    const deps = opts.deps ?? defaultDeps;
    const adapter = (p) => opts.adapters?.[p] ?? notImplementedAdapter(p);
    const items = [];
    const wanted = req.connectors.includes("*") ? reg.connectors : req.connectors.map((id) => reg.connectors.find((c) => c.id === id) ?? id);
    const needsConnector = req.op !== "list" && req.op !== "probe";
    for (const c of wanted) {
        if (typeof c === "string") {
            for (const p of req.platforms)
                items.push({ connector: c, platform: p, op: req.op, status: "error", detail: "unknown connector id" });
            continue;
        }
        for (const platform of req.platforms) {
            const base = { connector: c.id, platform, op: req.op };
            if (!c.platforms.includes(platform)) {
                items.push({ ...base, status: "skipped", detail: "platform not enabled for this connector" });
                continue;
            }
            try {
                const rc = needsConnector ? await resolveConnector(c, platform, red, deps) : undefined;
                if (req.dryRun) {
                    items.push({ ...base, status: "dry-run", detail: describe(c, rc, red) });
                    continue;
                }
                const ctx = { platform, redact: (s) => red.redact(s) };
                const a = adapter(platform);
                const ifx = req.ifExisting ?? reg.defaults?.ifExisting ?? "skip";
                const out = req.op === "list" ? { status: "ok", detail: (await a.list(ctx)).names.join(", ") }
                    : req.op === "probe" ? await a.probe(ctx)
                        : req.op === "add" ? await a.add(ctx, rc, ifx)
                            : req.op === "remove" ? await a.remove(ctx, rc)
                                : req.op === "update" ? await a.update(ctx, rc)
                                    : await a.verify(ctx, rc);
                items.push({ ...base, status: out.status, detail: out.detail ? red.redact(out.detail) : undefined });
            }
            catch (e) {
                items.push({ ...base, status: "error", detail: red.redact(e.message) });
            }
        }
    }
    return { ok: items.every((i) => i.status !== "error"), items };
}
async function resolveConnector(c, platform, red, deps) {
    const url = await resolve(c.urlByPlatform?.[platform] ?? c.url, red, deps);
    red.add(url.includes("?") ? url.slice(url.indexOf("?") + 1) : undefined);
    const headerValue = c.auth.mode === "header" && c.auth.headerValue ? await resolve(c.auth.headerValue, red, deps) : undefined;
    return { def: c, url, headerValue };
}
function describe(c, rc, red) {
    if (!rc)
        return `${c.name}: ok`;
    const hdr = rc.headerValue ? `, header ${c.auth.headerName}=<resolved ${rc.headerValue.length} chars>` : "";
    return red.redact(`${c.name}: url=${rc.url}${hdr}`);
}
//# sourceMappingURL=runner.js.map