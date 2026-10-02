import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { RunRequest } from "../src/core/types.js";

const TOKEN = "t".repeat(40);
let base = "", close: () => void = () => {};
const seen: RunRequest[] = [];

beforeAll(async () => {
  const app = buildApp({ token: TOKEN, registryPath: "registry/connectors.json", allowedHosts: ["localhost", "127.0.0.1"], runFn: async (_reg, req) => { seen.push(req); return { ok: true, items: [{ connector: req.connectors[0] ?? "*", platform: req.platforms[0], op: req.op, status: "dry-run", detail: "stub" }] }; } });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  close = () => srv.close();
});
afterAll(() => close());

const rpc = (body: unknown, headers: Record<string, string> = {}) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
const parse = async (r: Response) => { const t = await r.text(); const m = /data: (.*)/.exec(t); return JSON.parse(m ? m[1] : t); };
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

describe("http front door", () => {
  it("health is open; /mcp is token-gated (header or ?token=)", async () => {
    expect((await fetch(base + "/health")).status).toBe(200);
    expect((await rpc(init)).status).toBe(401);
    expect((await rpc(init, { "x-api-key": "wrong" })).status).toBe(401);
    expect((await rpc(init, { "x-api-key": TOKEN })).status).toBe(200);
    expect((await fetch(base + `/mcp?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) })).status).toBe(200);
  });
  it("lists exactly the two tools, and cc_run exposes no url/token/secret argument", async () => {
    const r = await parse(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "x-api-key": TOKEN }));
    const names = r.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["cc_list_registry", "cc_run"]);
    const props = Object.keys(r.result.tools.find((t: { name: string }) => t.name === "cc_run").inputSchema.properties);
    expect(props.sort()).toEqual(["connectors", "dry_run", "if_existing", "include_test", "op", "platforms"]);
    expect(props.join(" ")).not.toMatch(/url|token|secret|password|header/i);
  });
  it("cc_run reaches the shared runner; unknown fields (e.g. a smuggled token) are rejected", async () => {
    const ok = await parse(await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cc_run", arguments: { op: "verify", connectors: ["helm-drive"], platforms: ["claude"], dry_run: true } } }, { "x-api-key": TOKEN }));
    expect(ok.result.isError).toBeFalsy();
    expect(seen.at(-1)).toMatchObject({ op: "verify", connectors: ["helm-drive"], platforms: ["claude"], dryRun: true });
    const bad = await parse(await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cc_run", arguments: { op: "add", connectors: ["x"], url: "https://evil/?token=abc" } } }, { "x-api-key": TOKEN }));
    expect(JSON.stringify(bad)).toMatch(/unrecognized|invalid/i);
    expect(JSON.stringify(bad)).toContain("unknown argument(s): url");
    expect(seen.every((r) => !JSON.stringify(r).includes("evil"))).toBe(true); // the smuggled value never reached the runner
  });
  it("cc_list_registry returns ids and platforms but no urls or secrets", async () => {
    const r = await parse(await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "cc_list_registry", arguments: {} } }, { "x-api-key": TOKEN }));
    const text = r.result.content[0].text as string;
    expect(text).toContain("helm-drive");
    expect(text).not.toMatch(/https?:\/\/|token|secret|\.env/i);
  });
});
