// @reqs REQ-D013 REQ-D014
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/cli.js";
import { signInStatuses } from "../src/core/reauth.js";
import { applyAlert, classifyHours, evaluateAlert, hoursLeftFromRecord, type SignInStatus } from "../src/core/signinHealth.js";
import type { Transport } from "../src/core/transport.js";
import type { ConnectorDef, GoogleOAuthDef, Registry } from "../src/core/types.js";

const NOW = Date.parse("2026-11-18T20:00:00.000Z");
const hoursAgo = (h: number) => JSON.stringify({ renewedAt: new Date(NOW - h * 3_600_000).toISOString(), byHost: "W540" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-signin-health-"));
const st = (connector: string, hoursLeft: number | undefined, state: SignInStatus["state"]): SignInStatus => ({ connector, hoursLeft, state });

describe("REQ-D014 hours left on a Google sign-in", () => {
  it("TC-D014-01 hours left from the renewal record", () => {
    expect(hoursLeftFromRecord(hoursAgo(24), NOW)).toMatchObject({ hoursLeft: 144, byHost: "W540" });
    expect(hoursLeftFromRecord(hoursAgo(0.5), NOW)?.hoursLeft).toBe(167.5);
  });
  it("TC-D014-02 missing, garbage and future-dated records give no value; an old one gives 0", () => {
    expect(hoursLeftFromRecord(undefined, NOW)).toBeUndefined();
    expect(hoursLeftFromRecord("{not json", NOW)).toBeUndefined();
    expect(hoursLeftFromRecord(JSON.stringify({ renewedAt: "yesterday" }), NOW)).toBeUndefined();
    expect(hoursLeftFromRecord(hoursAgo(-2), NOW)).toBeUndefined();
    expect(hoursLeftFromRecord(hoursAgo(24 * 8), NOW)?.hoursLeft).toBe(0);
  });
  it("TC-D014-03 the state boundaries", () => {
    expect(classifyHours(72.1, 72)).toBe("ok");
    expect(classifyHours(72, 72)).toBe("warn");
    expect(classifyHours(0.1, 72)).toBe("warn");
    expect(classifyHours(0, 72)).toBe("expired");
    expect(classifyHours(undefined, 72)).toBe("unknown");
  });
  it("TC-D014-04 status reads every googleOAuth connector's record and starts no consent", async () => {
    const g = (dir: string): GoogleOAuthDef => ({ secretsDir: dir, scopes: ["s"], account: { vaultLabel: "L" } });
    const c = (id: string, gg?: GoogleOAuthDef): ConnectorDef => ({ id, name: id, url: { type: "literal", value: "https://x.example/mcp" }, auth: { mode: "none" }, platforms: ["claude"], googleOAuth: gg });
    const reg: Registry = { version: 1, connectors: [c("a", g("/a")), c("b", g("/b")), c("plain")] };
    const files: Record<string, string> = { "/a/token.renewed.json": hoursAgo(10), "/b/token.renewed.json": hoursAgo(150) };
    const reads: string[] = [];
    const t: Transport = { where: "fake", join: (d, n) => `${d}/${n}`, readFile: async (f) => { reads.push(f); return files[f]; }, replaceFile: async () => { throw new Error("status must never write"); }, exec: async () => { throw new Error("status must never run a command"); }, fetchText: async () => { throw new Error("status must never fetch"); } };
    const out = await signInStatuses(reg, { connectors: ["*"] }, { transport: () => t, now: () => NOW }, 72);
    expect(out.map((s) => [s.connector, s.hoursLeft, s.state])).toEqual([["a", 158, "ok"], ["b", 18, "warn"]]);
    expect(reads).toEqual(["/a/token.renewed.json", "/b/token.renewed.json"]);
  });
  it("TC-D014-05 --status and --warn-hours parse, and a bad warn limit is refused", () => {
    expect(parseFlags(["--all", "--status", "--warn-hours", "48", "--run-failed"])).toMatchObject({ ids: ["*"], status: true, warnHours: 48, runFailed: true });
    expect(parseFlags(["--all"])).toMatchObject({ status: false, runFailed: false });
    expect(parseFlags(["--status", "--warn-hours", "0"])).toEqual({ error: expect.stringMatching(/warn-hours/) });
    expect(parseFlags(["--status", "--warn-hours"])).toEqual({ error: expect.stringMatching(/warn-hours/) });
  });
  it("TC-D014-06 the renewing host is in the status data and the alert file, not in the printed lines", async () => {
    const g: GoogleOAuthDef = { secretsDir: "/a", scopes: ["s"], account: { vaultLabel: "L" } };
    const reg: Registry = { version: 1, connectors: [{ id: "a", name: "a", url: { type: "literal", value: "https://x.example/mcp" }, auth: { mode: "none" }, platforms: ["claude"], googleOAuth: g }] };
    const t: Transport = { where: "fake", join: (d, n) => `${d}/${n}`, readFile: async () => hoursAgo(150), replaceFile: async () => { throw new Error("no write"); }, exec: async () => { throw new Error("no exec"); }, fetchText: async () => { throw new Error("no fetch"); } };
    const out = await signInStatuses(reg, { connectors: ["*"] }, { transport: () => t, now: () => NOW }, 72);
    expect(out[0]).toMatchObject({ connector: "a", state: "warn", byHost: "W540" });
    const alert = evaluateAlert(out, { warnHours: 72, nowIso: "2026-11-18T20:00:00.000Z" });
    expect(alert.file.connectors[0]).toMatchObject({ connector: "a", byHost: "W540" });
    expect(alert.lines.join("\n")).not.toMatch(/W540/);
  });
});

describe("REQ-D013 a failed or overdue renewal always raises an alert", () => {
  const scripts = path.resolve(import.meta.dirname, "..", "scripts");
  it("TC-D013-01 the installer defaults are daily with a 3-day renewal threshold and the runner starts Chrome on its own desktop", () => {
    const inst = fs.readFileSync(path.join(scripts, "install-reauth-task.ps1"), "utf8");
    expect(inst).toMatch(/\[ValidateRange\(1, 6\)\]\[int\]\$DaysInterval = 1\b/);
    expect(inst).toMatch(/\[double\]\$OnlyIfOlderThanDays = 3\b/);
    const run = fs.readFileSync(path.join(scripts, "run-reauth.ps1"), "utf8");
    expect(run).toMatch(/CC_CHROME_DESKTOP/);
    expect(run).toMatch(/"own"/);
  });
  it("TC-D013-02 the runner calls the status check after every run, passes --run-failed on failure and exits non-zero on an alert", () => {
    const run = fs.readFileSync(path.join(scripts, "run-reauth.ps1"), "utf8");
    expect(run).toMatch(/reauth --all --status/);
    expect(run).toMatch(/--run-failed/);
    const finished = run.indexOf("scheduled cc reauth finished");
    const status = run.indexOf("reauth --all --status");
    expect(finished).toBeGreaterThan(0);
    expect(status).toBeGreaterThan(finished);
    expect(run).toMatch(/\$statusCode -ne 0/);
  });
  it("TC-D013-03 a sign-in under the warn limit raises the alert: file, ALERT line, exit 1", async () => {
    const dir = tmp();
    const a = evaluateAlert([st("a", 100, "ok"), st("b", 30, "warn")], { warnHours: 72, nowIso: "2026-11-18T20:00:00.000Z" });
    expect(a.raised).toBe(true);
    expect(a.lines.join("\n")).toMatch(/ALERT.*b.*30/);
    const r = await applyAlert(a, { dir });
    expect(r.exit).toBe(1);
    const file = JSON.parse(fs.readFileSync(path.join(dir, "reauth-ALERT.json"), "utf8"));
    expect(file.connectors.map((c: { connector: string }) => c.connector)).toEqual(["b"]);
  });
  it("TC-D013-04 an expired, an unreadable and a failed-run status each raise the alert", () => {
    const opts = { warnHours: 72, nowIso: "2026-11-18T20:00:00.000Z" };
    expect(evaluateAlert([st("a", 0, "expired")], opts).raised).toBe(true);
    expect(evaluateAlert([st("a", undefined, "unknown")], opts).raised).toBe(true);
    expect(evaluateAlert([st("a", 160, "ok")], { ...opts, runFailed: true }).raised).toBe(true);
    expect(evaluateAlert([st("a", 160, "ok")], { ...opts, runFailed: true }).lines.join(" ")).toMatch(/renewal run failed/i);
  });
  it("TC-D013-05 healthy sign-ins raise nothing and remove an old alert file", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "reauth-ALERT.json"), "{}");
    const a = evaluateAlert([st("a", 160, "ok"), st("b", 100, "ok")], { warnHours: 72, nowIso: "2026-11-18T20:00:00.000Z" });
    expect(a.raised).toBe(false);
    const r = await applyAlert(a, { dir });
    expect(r.exit).toBe(0);
    expect(fs.existsSync(path.join(dir, "reauth-ALERT.json"))).toBe(false);
  });
  it("TC-D013-06 the hook is run with the alert file path as its only argument", async () => {
    const dir = tmp();
    const calls: { cmd: string; args: string[]; shell: unknown }[] = [];
    const a = evaluateAlert([st("a", 5, "warn")], { warnHours: 72, nowIso: "2026-11-18T20:00:00.000Z" });
    const r = await applyAlert(a, { dir, hookCommand: "C:/hooks/route.cmd", execFile: async (cmd, args, o) => { calls.push({ cmd, args, shell: (o as { shell?: unknown })?.shell }); } });
    expect(calls).toEqual([{ cmd: "C:/hooks/route.cmd", args: [path.join(dir, "reauth-ALERT.json")], shell: undefined }]);
    expect(r.hookOk).toBe(true);
  });
  it("TC-D013-07 a failing hook does not hide the alert", async () => {
    const dir = tmp();
    const a = evaluateAlert([st("a", 5, "warn")], { warnHours: 72, nowIso: "2026-11-18T20:00:00.000Z" });
    const r = await applyAlert(a, { dir, hookCommand: "C:/missing.cmd", execFile: async () => { throw new Error("spawn ENOENT"); } });
    expect(r.exit).toBe(1);
    expect(r.hookOk).toBe(false);
    expect(fs.existsSync(path.join(dir, "reauth-ALERT.json"))).toBe(true);
    expect(r.lines.join("\n")).toMatch(/hook failed/i);
  });
  it("TC-D013-08 the alert file and lines carry no secret, code or email", async () => {
    const dir = tmp();
    const dirty = { ...st("helm-drive", 5, "warn"), note: "me@example.com 4/0AUTHCODE refresh 1//TOKEN" } as SignInStatus;
    const a = evaluateAlert([dirty], { warnHours: 72, nowIso: "2026-11-18T20:00:00.000Z" });
    await applyAlert(a, { dir });
    const text = a.lines.join("\n") + fs.readFileSync(path.join(dir, "reauth-ALERT.json"), "utf8");
    expect(text).not.toMatch(/@|AUTHCODE|TOKEN|password/i);
  });
});