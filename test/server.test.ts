import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server/app.js";
import { packageVersion } from "../src/server/version.js";
import type { ReauthRequest } from "../src/core/reauth.js";
import type { RunRequest } from "../src/core/types.js";

const TOKEN = "t".repeat(40);
let base = "", close: () => void = () => {};
const seen: RunRequest[] = [];
const seenReauth: ReauthRequest[] = [];
const seenSignin: { account?: string; waitMs: number }[] = [];

beforeAll(async () => {
  const app = buildApp({
    token: TOKEN, registryPath: "registry/connectors.json", allowedHosts: ["localhost", "127.0.0.1"],
    runFn: async (_reg, req) => { seen.push(req); return { ok: true, items: [{ connector: req.connectors[0] ?? "*", platform: req.platforms[0], op: req.op, status: "dry-run", detail: "stub" }] }; },
    reauthFn: async (_reg, req) => { seenReauth.push(req); return { ok: true, items: req.connectors.map((c) => ({ connector: c, status: "dry-run" as const, detail: "stub" })) }; },
    signinFn: async (account, waitMs) => { seenSignin.push({ account, waitMs }); return { status: "signed-in", account: account ?? "main", email: "invented@example.test", confirmed: true }; },
  });
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
  it("ACCT-C09: cc_run and cc_signin describe the account as required, never as defaulting to the server's account", async () => {
    const r = await parse(await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { "x-api-key": TOKEN }));
    for (const name of ["cc_run", "cc_signin"]) {
      const d = r.result.tools.find((t: { name: string }) => t.name === name).inputSchema.properties.account.description as string;
      expect(d).toMatch(/^Account id from cc_list_accounts.*Required: without it .* refused \(ACCOUNT_NOT_AUTHORIZED\); the server's default account is never used/);
      expect(d).not.toMatch(/Default: the server's default account/);
    }
  });
  it("health is open; /mcp is token-gated (header or ?token=)", async () => {
    expect((await fetch(base + "/health")).status).toBe(200);
    expect((await rpc(init)).status).toBe(401);
    expect((await rpc(init, { "x-api-key": "wrong" })).status).toBe(401);
    expect((await rpc(init, { "x-api-key": TOKEN })).status).toBe(200);
    expect((await fetch(base + `/mcp?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) })).status).toBe(200);
  });
  it("health reports the version in package.json, not the 0.0.1 fallback (buildApp's default; the entry point passes none)", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    expect(packageVersion()).toBe(pkg);
    expect(pkg).not.toBe("0.0.1");
    const app = buildApp({ token: TOKEN, registryPath: "registry/connectors.json", allowedHosts: ["localhost", "127.0.0.1"] }); // no version given: the default must be the real one
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    try {
      const body = await (await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/health`)).json() as { version: string };
      expect(body.version).toBe(pkg);
    } finally { srv.close(); }
  });
  it("lists exactly the five tools, and cc_run / cc_reauth / cc_signin expose no url/token/secret argument", async () => {
    const r = await parse(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "x-api-key": TOKEN }));
    const names = r.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["cc_list_accounts", "cc_list_registry", "cc_reauth", "cc_run", "cc_signin"]);
    const props = Object.keys(r.result.tools.find((t: { name: string }) => t.name === "cc_run").inputSchema.properties);
    expect(props.sort()).toEqual(["account", "connectors", "dry_run", "if_existing", "include_test", "op", "platforms"]);
    expect(props.join(" ")).not.toMatch(/url|token|secret|password|header/i);
    const rprops = Object.keys(r.result.tools.find((t: { name: string }) => t.name === "cc_reauth").inputSchema.properties);
    expect(rprops.sort()).toEqual(["connectors", "dry_run", "include_test", "only_if_older_than_days"]);
    expect(rprops.join(" ")).not.toMatch(/url|token|secret|password|header|code/i);
    const sprops = Object.keys(r.result.tools.find((t: { name: string }) => t.name === "cc_signin").inputSchema.properties);
    expect(sprops.sort()).toEqual(["account", "wait_for_vault_minutes"]);
  });
  it("cc_run carries the account id; cc_signin takes an account id only and refuses a smuggled password", async () => {
    const ok = await parse(await rpc({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "cc_run", arguments: { op: "list", account: "second-acct" } } }, { "x-api-key": TOKEN }));
    expect(ok.result.isError).toBeFalsy();
    expect(seen.at(-1)).toMatchObject({ op: "list", account: "second-acct" });
    const si = await parse(await rpc({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "cc_signin", arguments: { account: "second-acct", wait_for_vault_minutes: 2 } } }, { "x-api-key": TOKEN }));
    expect(si.result.isError).toBeFalsy();
    expect(seenSignin.at(-1)).toEqual({ account: "second-acct", waitMs: 120_000 });
    const bad = await parse(await rpc({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "cc_signin", arguments: { account: "second-acct", password: "pw-evil" } } }, { "x-api-key": TOKEN }));
    expect(JSON.stringify(bad)).toContain("unknown argument(s): password");
    const list = await parse(await rpc({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "cc_list_accounts", arguments: {} } }, { "x-api-key": TOKEN }));
    const rows = JSON.parse(list.result.content[0].text) as { id: string; default: boolean }[];
    expect(rows.filter((x) => x.default)).toHaveLength(1);
  });
  it("cc_reauth reaches the shared renewal with registry ids only; smuggled fields are rejected", async () => {
    const ok = await parse(await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "cc_reauth", arguments: { connectors: ["helm-audio-mcp"], dry_run: true } } }, { "x-api-key": TOKEN }));
    expect(ok.result.isError).toBeFalsy();
    expect(seenReauth.at(-1)).toMatchObject({ connectors: ["helm-audio-mcp"], dryRun: true, includeTest: false });
    const bad = await parse(await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "cc_reauth", arguments: { connectors: ["x"], code: "4/0evil", secretsDir: "C:/elsewhere" } } }, { "x-api-key": TOKEN }));
    expect(JSON.stringify(bad)).toContain("unknown argument(s): code, secretsDir");
    expect(seenReauth.every((r) => !JSON.stringify(r).includes("evil"))).toBe(true);
    const badId = await parse(await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "cc_reauth", arguments: { connectors: ["../etc/passwd"] } } }, { "x-api-key": TOKEN }));
    expect(JSON.stringify(badId)).toMatch(/invalid|error/i);
  });
  it("cc_reauth passes only_if_older_than_days through as onlyIfOlderThanDays and rejects non-positive values like the CLI", async () => {
    const ok = await parse(await rpc({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "cc_reauth", arguments: { connectors: ["helm-audio-mcp"], dry_run: true, only_if_older_than_days: 4.75 } } }, { "x-api-key": TOKEN }));
    expect(ok.result.isError).toBeFalsy();
    expect(seenReauth.at(-1)).toMatchObject({ connectors: ["helm-audio-mcp"], onlyIfOlderThanDays: 4.75 });
    const none = await parse(await rpc({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "cc_reauth", arguments: { connectors: ["helm-audio-mcp"], dry_run: true } } }, { "x-api-key": TOKEN }));
    expect(none.result.isError).toBeFalsy();
    expect(seenReauth.at(-1)?.onlyIfOlderThanDays).toBeUndefined();
    for (const [i, v] of [0, -1, "soon"].entries()) {
      const before = seenReauth.length;
      const bad = await parse(await rpc({ jsonrpc: "2.0", id: 22 + i, method: "tools/call", params: { name: "cc_reauth", arguments: { connectors: ["helm-audio-mcp"], only_if_older_than_days: v } } }, { "x-api-key": TOKEN }));
      expect(JSON.stringify(bad)).toMatch(/invalid|error|greater than 0/i);
      expect(seenReauth.length).toBe(before);
    }
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
    expect(text).toContain("helm-secret"); // an id may contain the word "secret"; the guard is structural, not a word filter
    expect(registryListingProblems(text)).toEqual([]);
  });
  it("the registry-listing guard still rejects a row that carries a url, a token or an env path", () => {
    const ok = { id: "helm-secret", name: "Secret store", platforms: ["grok"], tier: "production", auth: "header" };
    expect(registryListingProblems(JSON.stringify([ok]))).toEqual([]);
    const bad: unknown[][] = [
      [{ ...ok, url: "https://example.test/mcp" }],                // extra key
      [{ ...ok, name: "see https://example.test/mcp" }],           // url in a value
      [{ ...ok, name: "example.test://x" }],                       // scheme separator
      [{ ...ok, auth: "token=abc" }],                              // token string
      [{ ...ok, name: "C:/secrets/connector.env" }],               // env path
      [{ ...ok, platforms: ["claude", "gemini"] }],                // unknown platform
      [{ ...ok, platforms: ["https://example.test"] }],            // url hidden in platforms
    ];
    for (const rows of bad) expect(registryListingProblems(JSON.stringify(rows)), JSON.stringify(rows)).not.toEqual([]);
    expect(registryListingProblems("not json")).not.toEqual([]);
    expect(registryListingProblems(JSON.stringify({ id: "x" }))).not.toEqual([]);
  });
});

/** Structural guard for cc_list_registry output: rows carry only id/name/platforms/tier/auth, platforms are known, and no value looks like a url, token or env path. */
function registryListingProblems(text: string): string[] {
  const KEYS = ["auth", "id", "name", "platforms", "tier"];
  const PLATFORMS = ["claude", "chatgpt", "grok"];
  const FORBIDDEN = ["http", "://", "token=", ".env"];
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { return ["not JSON"]; }
  if (!Array.isArray(rows)) return ["not an array"];
  const problems: string[] = [];
  rows.forEach((row, i) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) { problems.push(`row ${i}: not an object`); return; }
    const keys = Object.keys(row).sort();
    if (keys.join() !== KEYS.join()) problems.push(`row ${i}: keys ${keys.join(",")}`);
    const platforms = (row as Record<string, unknown>).platforms;
    if (!Array.isArray(platforms) || platforms.some((p) => !PLATFORMS.includes(p as string))) problems.push(`row ${i}: platforms`);
    const values: string[] = [];
    const walk = (v: unknown): void => { if (typeof v === "string") values.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
    walk(row);
    for (const v of values) for (const f of FORBIDDEN) if (v.toLowerCase().includes(f)) problems.push(`row ${i}: value contains ${f}`);
  });
  return problems;
}
